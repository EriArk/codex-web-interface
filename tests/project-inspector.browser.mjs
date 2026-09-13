import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect, webkit } from "@playwright/test";
import { handoffFixture } from "./handoff-fixture.mjs";

await mkdir(".local/qa-project-inspector", { recursive: true });
for (const [engine, type] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
  const origin = "http://127.0.0.1:18853",
    f = await handoffFixture(origin),
    root = await mkdtemp(join(tmpdir(), "inspector-browser-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "-b", "main");
  await writeFile(join(root, "readme.md"), "# Файл проекта\n\nИсходный текст\n");
  git("remote", "add", "origin", "https://github.com/owner/fixture-project.git");
  git("add", ".");
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "Начало проекта",
  );
  await writeFile(join(root, "readme.md"), "# Файл проекта\n\nНовый текст\n");
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src/пример.ts"), "export const value = 42;\n");
  f.sessions.config.machines[0].type = "local-linux";
  f.sessions.config.projects[0].workingDirectory = root;
  f.store.db.prepare("UPDATE threads SET origin='web' WHERE id=?").run(f.thread.id);
  f.store.setPreferences({
    projectId: "project",
    threadId: f.thread.id,
    theme: "crt-green",
    view: "chat",
  });
  f.store.result(f.thread.id, "change", "turn", "fileChange", "Изменён readme", {
    changes: [{ path: join(root, "readme.md"), kind: "update", diff: "Сохранённый diff" }],
  });
  const sibling = f.store.createThread("project", "native-sibling", "Previous chat");
  f.store.result(
    sibling.id,
    "sibling-result",
    "sibling-turn",
    "build",
    "Проверка из предыдущего чата",
    { status: "success" },
  );
  const otherRoot = await mkdtemp(join(tmpdir(), "inspector-other-"));
  await writeFile(join(otherRoot, "README.md"), "# Второй проект\n\nТолько второй проект\n");
  await writeFile(join(otherRoot, "second-only.txt"), "Other file");
  f.sessions.config.projects.push({
    id: "other",
    name: "Other project",
    machineId: "pc",
    workingDirectory: otherRoot,
    enabled: true,
  });
  f.store.createThread("other", "native-other", "Other chat");
  const browser = await type.launch(),
    context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      serviceWorkers: "block",
    });
  try {
    await f.app.listen({ port: 18853, host: "127.0.0.1" });
    const [name, value] = f.headers.cookie.split("=");
    await context.addCookies([{ name, value, url: origin, httpOnly: true, sameSite: "Strict" }]);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.route("**/api/projects/project/git/releases", (route) =>
      route.fulfill({
        json: {
          state: "ok",
          checkedAt: Date.now(),
          url: "https://github.com/owner/fixture-project/releases",
          items: [
            {
              id: "1",
              name: "Первый релиз",
              tag: "v1.0",
              body: "## Что изменилось\n\n- Исправлена навигация\n- Добавлен просмотр",
              publishedAt: "2026-09-10T00:00:00Z",
              url: "https://github.com/owner/fixture-project/releases/tag/v1.0",
              assets: 2,
              prerelease: false,
              draft: false,
              truncated: false,
            },
          ],
        },
      }),
    );
    await page.goto(origin);
    const editor = page.getByRole("textbox", { name: "Сообщение Codex" });
    await expect(editor).toBeVisible();
    await editor.fill("Не терять черновик");
    const pane = page.locator(".project-tool-window[open]");
    const closeTool = async () => {
      if (await pane.count())
        await pane
          .locator(".inspector-heading")
          .getByRole("button", { name: /^Закрыть/ })
          .click();
    };
    const openTool = async (name) => {
      await closeTool();
      await page.getByRole("button", { name: name + " проекта", exact: true }).click();
      await expect(pane).toBeVisible();
    };
    await openTool("Файлы");
    await expect(pane).toBeVisible();
    await pane.getByRole("button", { name: /^readme.md/ }).tap();
    const selectedRow = pane.locator("li[data-file-path='readme.md']");
    await expect(selectedRow.getByRole("region", { name: "Выбранный файл" })).toBeVisible();
    await expect(pane.locator(".inspector-scroll > .inspector-selected")).toHaveCount(0);
    await page.screenshot({
      animations: "disabled",
      path: `.local/qa-project-inspector/${engine}-inline-file.png`,
    });
    await pane.getByRole("button", { name: "Открыть файл", exact: true }).tap();
    const dialog = page.locator(".download-dialog[open]");
    await expect(dialog.locator("pre")).toContainText("Новый текст");
    await dialog.getByRole("button", { name: /Закрыть/ }).tap();
    await expect(pane).toBeVisible();
    await openTool("Git");
    await expect(
      pane.getByRole("region", { name: "Репозиторий проекта" }).getByText("main", { exact: true }),
    ).toBeVisible();
    await expect(pane.getByRole("region", { name: "README проекта" })).toContainText("Новый текст");
    await page.screenshot({
      animations: "disabled",
      path: `.local/qa-project-inspector/${engine}-phone-overview.png`,
    });
    await pane.getByRole("button", { name: "Релизы", exact: true }).click();
    await expect(pane.getByText("Исправлена навигация", { exact: true })).toBeVisible();
    await expect(pane.getByRole("link", { name: "Открыть релиз", exact: true })).toHaveAttribute(
      "href",
      "https://github.com/owner/fixture-project/releases/tag/v1.0",
    );
    await page.screenshot({
      animations: "disabled",
      path: `.local/qa-project-inspector/${engine}-phone-releases.png`,
    });
    await pane.getByRole("button", { name: /^Изменения/ }).tap();
    await pane.getByRole("button", { name: /M readme.md/ }).tap();
    await expect(pane.locator(".inspector-diff")).toContainText("+Новый текст");
    await page.screenshot({
      animations: "disabled",
      path: `.local/qa-project-inspector/${engine}-phone-diff.png`,
    });
    await closeTool();
    await expect(editor).toHaveValue("Не терять черновик");
    await page
      .getByRole("button", { name: /^Результаты/ })
      .filter({ visible: true })
      .last()
      .tap();
    const result = page.getByRole("region", { name: /^Результаты/ });
    await expect(result.getByText("Проверка из предыдущего чата", { exact: true })).toBeVisible();
    await expect(result.getByRole("button", { name: "Диалог", exact: true })).toHaveCount(0);
    const siblingCard = result
      .locator(".result-card")
      .filter({ hasText: "Проверка из предыдущего чата" });
    // The project library retains the source chat identity for precise backlinks.
    const library = await page.request.get(origin + "/api/projects/project/results");
    assert.equal(
      (await library.json()).items.find((item) => item.title === "Проверка из предыдущего чата")
        .threadId,
      sibling.id,
    );
    await expect(siblingCard).toBeVisible();
    await result.locator(".file-change summary").tap();
    await result.getByRole("button", { name: "Посмотреть файл", exact: true }).tap();
    await expect(pane.locator('li[data-file-path="readme.md"]')).toContainText("Открыть файл");
    await expect(
      pane.locator(".inspector-list").getByRole("button", { name: /^readme.md/ }),
    ).toBeVisible();
    await expect(pane.getByRole("alert")).toHaveCount(0);
    await page.setViewportSize({ width: 844, height: 390 });
    await page.screenshot({
      animations: "disabled",
      path: `.local/qa-project-inspector/${engine}-landscape.png`,
    });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.setViewportSize({ width: 1366, height: 1024 });
    await expect(
      pane.getByRole("complementary", { name: "Содержимое файла" }).locator("pre"),
    ).toContainText("Новый текст");
    const columns = await pane.evaluate((node) => {
      const list = node.querySelector(".inspector-scroll").getBoundingClientRect();
      const preview = node.querySelector(".inspector-preview").getBoundingClientRect();
      return {
        list: list.width,
        preview: preview.width,
        sideBySide: preview.left >= list.right - 1,
      };
    });
    assert(columns.list > 300 && columns.preview > 400 && columns.sideBySide);
    await page.screenshot({
      animations: "disabled",
      path: `.local/qa-project-inspector/${engine}-tablet-files.png`,
    });
    await openTool("Git");
    await expect(
      pane.getByRole("region", { name: "Репозиторий проекта" }).getByText("main", { exact: true }),
    ).toBeVisible();
    await pane.getByRole("button", { name: "Обзор", exact: true }).click();
    await pane.locator(".inspector-commits summary").click();
    for (const theme of ["crt-green", "organizer", "hitech-2000s", "classic-dark"]) {
      await closeTool();
      await page
        .getByRole("button", { name: "Настройки", exact: true })
        .filter({ visible: true })
        .first()
        .click();
      await page.locator('.settings-browser[open] [data-category="appearance"]').click();
      await expect(
        page.locator(".settings-dialog").getByRole("button", { name: /^(Файлы|Git) проекта$/ }),
      ).toHaveCount(0);
      await page.locator(`.theme-option.${theme} input`).check();
      await page.getByRole("button", { name: "Закрыть настройки", exact: true }).click();
      await openTool("Git");
      await page.screenshot({
        animations: "disabled",
        path: `.local/qa-project-inspector/${engine}-tablet-${theme}.png`,
      });
    }
    const controls = await page
      .locator(".workspace-header > button")
      .evaluateAll((nodes) => nodes.map((n) => n.getAttribute("aria-label")));
    assert.equal(controls.indexOf("Файлы проекта"), controls.indexOf("Создать диалог") + 1);
    assert.equal(controls.indexOf("Git проекта"), controls.indexOf("Файлы проекта") + 1);
    assert(!controls.includes("Настройки"));
    for (const width of [320, 390, 768, 1024, 1280, 1376, 1920]) {
      const height = width < 900 ? 844 : 1032;
      await page.setViewportSize({ width, height });
      await expect
        .poll(() =>
          page.evaluate(() =>
            parseFloat(document.documentElement.style.getPropertyValue("--app-height")),
          ),
        )
        .toBe(height);
      const bounds = await pane.boundingBox();
      assert(
        bounds.x >= 0 &&
          bounds.y >= 0 &&
          bounds.x + bounds.width <= width + 1 &&
          bounds.y + bounds.height <= height + 1,
        `Git window fits ${width}`,
      );
      assert(
        await pane.evaluate((node) => node.scrollWidth <= node.clientWidth),
        `Git content fits ${width}`,
      );
      const buttons = await page
        .locator(".workspace-header > .icon-button:visible")
        .evaluateAll((nodes) =>
          nodes.map((node) => {
            const r = node.getBoundingClientRect();
            return { width: r.width, height: r.height, right: r.right };
          }),
        );
      assert(
        buttons.every((b) => b.width === b.height && b.width >= 44 && b.right <= width),
        `square header controls ${width}`,
      );
    }
    await page.setViewportSize({ width: 1366, height: 1024 });
    await openTool("Файлы");
    await pane.getByRole("button", { name: /^src/ }).click();
    await expect(pane.getByRole("button", { name: /^пример.ts/ })).toBeVisible();
    await closeTool();
    await expect(page.getByRole("button", { name: "Файлы проекта", exact: true })).toBeFocused();
    await openTool("Файлы");
    await expect(pane.getByRole("button", { name: /^пример.ts/ })).toBeVisible();
    await pane.getByRole("button", { name: "Ввести путь", exact: true }).click();
    await pane.getByRole("textbox", { name: "Путь в проекте" }).fill("src");
    await page.evaluate(() => {
      Object.defineProperty(visualViewport, "height", { configurable: true, value: 450 });
      Object.defineProperty(visualViewport, "offsetTop", { configurable: true, value: 80 });
      visualViewport.dispatchEvent(new Event("resize"));
    });
    await expect(page.locator("html")).toHaveAttribute("data-keyboard", "true");
    const keyboardBounds = await pane.boundingBox();
    assert(keyboardBounds.y >= 80 && keyboardBounds.y + keyboardBounds.height <= 530);
    await page.evaluate(() => {
      delete visualViewport.height;
      delete visualViewport.offsetTop;
      visualViewport.dispatchEvent(new Event("resize"));
    });
    await openTool("Git");
    let releaseOld,
      began = false;
    const gate = new Promise((resolve) => (releaseOld = resolve));
    await page.route("**/api/projects/project/git/repository", async (route) => {
      began = true;
      await gate;
      await route
        .fulfill({
          json: {
            repository: true,
            name: "WRONG OLD PROJECT",
            readme: { path: "README.md", text: "WRONG OLD README", truncated: false },
            branches: [],
            tags: [],
          },
        })
        .catch(() => {});
    });
    await pane.getByRole("button", { name: "Обновить Git" }).click();
    await expect.poll(() => began).toBe(true);
    await closeTool();
    await page.locator('.nav-project[data-project-id="other"]').filter({ visible: true }).click();
    await openTool("Файлы");
    await expect(pane.locator(".inspector-heading")).toContainText("Other project");
    await expect(pane.getByRole("button", { name: /^second-only.txt/ })).toBeVisible();
    await openTool("Git");
    await expect(pane.getByRole("region", { name: "README проекта" })).toContainText(
      "Только второй проект",
    );
    releaseOld();
    await page.waitForTimeout(100);
    await expect(pane.getByText("WRONG OLD README", { exact: true })).toHaveCount(0);
    await expect(pane.getByRole("region", { name: "README проекта" })).toContainText(
      "Только второй проект",
    );
    assert.deepEqual(errors, []);
    assert.equal(
      f.calls.filter((c) => ["thread/resume", "turn/start"].includes(c.method)).length,
      0,
    );
    assert.equal(f.desktopCalls.filter((a) => a !== "Status").length, 0);
    console.log(
      engine +
        ": private file preview, Git diff, result jump, phone/landscape/tablet, themes and unchanged draft; no writer acquired",
    );
  } finally {
    await context.close();
    await browser.close();
    await f.close();
    await rm(root, { recursive: true, force: true });
    await rm(otherRoot, { recursive: true, force: true });
  }
}
