import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect, webkit } from "@playwright/test";
import { handoffFixture } from "./handoff-fixture.mjs";

await mkdir(".local/qa-file-tools", { recursive: true });
for (const [engine, type] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
  const origin = "http://127.0.0.1:18873",
    f = await handoffFixture(origin),
    root = await mkdtemp(join(tmpdir(), "file-editor-browser-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "-b", "main");
  await writeFile(join(root, "sample.ts"), "export const value = 1;\r\n");
  await writeFile(join(root, "preview.html"), "<h1>Исходная страница</h1>");
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "Initial",
  );
  f.sessions.config.machines[0].type = "local-linux";
  f.sessions.config.projects[0].workingDirectory = root;
  f.store.setPreferences({
    projectId: "project",
    threadId: f.thread.id,
    theme: "crt-green",
    view: "chat",
    machineClients: { pc: "web" },
  });
  const browser = await type.launch(),
    context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
    });
  try {
    // Block the app worker via its script, not Playwright's injected navigator getter,
    // which itself throws inside an opaque-origin HTML preview frame.
    await context.route("**/sw.js", (route) =>
      route.fulfill({ status: 404, contentType: "application/javascript", body: "" }),
    );
    await f.app.listen({ host: "127.0.0.1", port: 18873 });
    const [name, value] = f.headers.cookie.split("=");
    await context.addCookies([{ name, value, url: origin }]);
    const page = await context.newPage(),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(origin);
    const composer = page.getByLabel("Сообщение Codex", { exact: true });
    await expect(composer).toBeVisible();
    await composer.fill("Сохранить чат");
    const pane = page.locator(".project-files[open]"),
      editor = page.locator(".file-editor[open]"),
      viewer = page.locator(".file-viewer-dialog[open]");
    const open = async () => {
      await page.getByRole("button", { name: "Файлы проекта", exact: true }).click();
      await expect(pane).toBeVisible();
      await pane
        .getByRole("button", { name: /^sample.ts/ })
        .first()
        .click();
    };
    const unlock = async () => {
      await pane.getByRole("button", { name: "Разблокировать файлы", exact: true }).click();
      await expect(
        pane.getByRole("button", { name: "Заблокировать файлы", exact: true }),
      ).toBeVisible();
    };
    const edit = async () => {
      await pane
        .getByRole("button", { name: "Редактировать", exact: true })
        .filter({ visible: true })
        .first()
        .click();
      await expect(editor.locator(".cm-content")).toBeVisible();
    };
    const text = async (value) => {
      await editor.locator(".cm-content").fill(value);
    };
    f.store.db.prepare("UPDATE threads SET status='running' WHERE id=?").run(f.thread.id);
    await open();
    await expect(pane.getByRole("button", { name: "Редактировать", exact: true })).toHaveCount(0);
    await pane.getByRole("button", { name: "Открыть файл", exact: true }).click();
    await expect(
      viewer.getByRole("button", { name: "Разблокировать и редактировать", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(viewer).toHaveCount(0);
    await expect(pane).toBeVisible();
    await unlock();
    await pane.getByRole("button", { name: "Открыть файл", exact: true }).click();
    await expect(viewer).toContainText("value = 1");
    await viewer.getByRole("button", { name: "Редактировать", exact: true }).click();
    await expect(editor.locator(".cm-lineNumbers")).toBeVisible();
    await text("export const value = 2;\n");
    await editor.getByRole("button", { name: "Предпросмотр", exact: true }).click();
    await expect(viewer).toHaveCount(2);
    const draftPreview = viewer.filter({ hasText: "Предпросмотр черновика" });
    await expect(draftPreview).toContainText("value = 2");
    assert.equal(await readFile(join(root, "sample.ts"), "utf8"), "export const value = 1;\r\n");
    const draftDownload = page.waitForEvent("download");
    await draftPreview.getByRole("link", { name: "Скачать черновик", exact: true }).click();
    assert.equal(
      await readFile(await (await draftDownload).path(), "utf8"),
      "export const value = 2;\r\n",
    );
    await page.keyboard.press("Escape");
    await expect(viewer).toHaveCount(1);
    await expect(editor).toBeVisible();
    await expect(editor.locator(".cm-content")).toContainText("value = 2");
    await editor.getByRole("button", { name: "Сохранить", exact: true }).click();
    await expect
      .poll(() => readFile(join(root, "sample.ts"), "utf8"))
      .toBe("export const value = 2;\r\n");
    f.store.db.prepare("UPDATE threads SET status='idle' WHERE id=?").run(f.thread.id);
    assert.match(git("diff").toString(), /value = 2/);
    assert.equal(git("diff", "--cached").toString(), "");
    await editor.getByRole("button", { name: "Закрыть редактор", exact: true }).click();
    await expect(viewer).toContainText("value = 2");
    await page.keyboard.press("Escape");
    await expect(pane).toBeVisible();
    await edit();
    await text("export const value = 3;\n");
    await writeFile(join(root, "sample.ts"), "\ufeffexport const external = 9;\n");
    await editor.getByRole("button", { name: "Сохранить", exact: true }).click();
    await expect(editor.locator(".file-editor-conflict")).toContainText("external = 9");
    await expect(editor.locator(".cm-content")).toContainText("value = 3");
    assert.match(await readFile(join(root, "sample.ts"), "utf8"), /external = 9/);
    await editor.getByRole("button", { name: "Закрыть редактор", exact: true }).click();
    await editor.getByRole("button", { name: "Закрыть с черновиком", exact: true }).click();
    await edit();
    await expect(editor.locator(".cm-content")).toContainText("value = 3");
    await expect(editor.locator(".file-editor-conflict")).toContainText("external = 9");
    await editor
      .getByRole("button", {
        name: "Я сравнил — сохранить мой текст при следующем сохранении",
        exact: true,
      })
      .click();
    await editor.getByRole("button", { name: "Сохранить", exact: true }).click();
    await expect.poll(() => readFile(join(root, "sample.ts"), "utf8")).toContain("value = 3");
    assert.equal(
      await readFile(join(root, "sample.ts"), "utf8"),
      "\ufeffexport const value = 3;\r\n",
    );
    let sends = 0,
      lose = true;
    await page.route("**/api/projects/project/file-tools", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      sends++;
      if (lose) {
        lose = false;
        await route.fetch();
        await route.abort("failed");
      } else await route.continue();
    });
    await text("export const value = 4;\n");
    await editor.getByRole("button", { name: "Сохранить", exact: true }).click();
    await expect(editor.getByRole("alert")).toBeVisible();
    assert.equal(sends, 1);
    await text("export const value = 3;\n");
    await editor.getByRole("button", { name: "Закрыть редактор", exact: true }).click();
    await expect(editor.locator(".file-editor-close")).toBeVisible();
    await expect(editor.getByRole("button", { name: "Не сохранять", exact: true })).toBeDisabled();
    await editor.getByRole("button", { name: "Продолжить редактирование", exact: true }).click();
    await text("export const value = 4;\n");
    await page.reload();
    await expect(composer).toHaveValue("Сохранить чат");
    await open();
    await unlock();
    await edit();
    await expect(editor.locator(".cm-content")).toContainText("value = 4");
    await editor.getByRole("button", { name: "Сохранить", exact: true }).click();
    await expect(editor.getByRole("button", { name: "Сохранить", exact: true })).toBeDisabled();
    await expect.poll(() => sends).toBe(2);
    await page.unroute("**/api/projects/project/file-tools");
    await text("my local draft");
    await writeFile(join(root, "sample.ts"), "\ufeffexport const latest = 5;\n");
    await editor.getByRole("button", { name: "Сохранить", exact: true }).click();
    await expect(editor.locator(".file-editor-conflict")).toContainText("latest = 5");
    page.once("dialog", (dialog) => dialog.accept());
    await editor.getByRole("button", { name: "Загрузить текущую версию", exact: true }).click();
    await expect(editor.locator(".cm-content")).toContainText("latest = 5");
    await text("export const latest = 6;\n");
    await editor.getByRole("button", { name: "Сохранить", exact: true }).click();
    await expect
      .poll(() => readFile(join(root, "sample.ts"), "utf8"))
      .toBe("\ufeffexport const latest = 6;\n");
    for (const theme of ["crt-green", "hitech-2000s", "organizer", "classic-dark"])
      for (const [width, height] of [
        [390, 500],
        [1024, 768],
      ]) {
        await page.setViewportSize({ width, height });
        await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
        await expect
          .poll(async () => {
            const box = await editor.boundingBox();
            return (
              box.x >= 0 &&
              box.y >= 0 &&
              box.x + box.width <= width + 1 &&
              box.y + box.height <= height + 1 &&
              Math.abs(box.x - (width - box.x - box.width)) <= 2 &&
              Math.abs(box.y - (height - box.y - box.height)) <= 2
            );
          })
          .toBe(true);
        await expect(editor.getByRole("button", { name: "Сохранить", exact: true })).toBeVisible();
        await page.screenshot({
          path: `.local/qa-file-tools/${engine}-${theme}-${width}.png`,
          animations: "disabled",
        });
      }
    await text("unsaved");
    await editor.getByRole("button", { name: "Закрыть редактор", exact: true }).click();
    await expect(editor.locator(".file-editor-close")).toBeVisible();
    await editor.getByRole("button", { name: "Не сохранять", exact: true }).click();
    await pane.getByRole("button", { name: "Закрыть файлы", exact: true }).click();
    await expect(composer).toHaveValue("Сохранить чат");
    await open();
    await expect(
      pane.getByRole("button", { name: "Разблокировать файлы", exact: true }),
    ).toBeVisible();
    await unlock();
    await pane.getByRole("button", { name: "Новый файл", exact: true }).click();
    const action = page.locator(".file-action-dialog[open]");
    await action.getByLabel("Имя файла или папки").fill("new.md");
    await action.getByRole("button", { name: "Создать", exact: true }).click();
    await expect(editor).toBeVisible();
    await expect(editor.locator(".cm-content")).toBeVisible();
    await text("# Новый документ\n\nНесохранённый **текст**.\n");
    await editor.getByRole("button", { name: "Предпросмотр", exact: true }).click();
    await expect(viewer.getByRole("heading", { name: "Новый документ" })).toBeVisible();
    assert.equal(await readFile(join(root, "new.md"), "utf8"), "");
    await viewer.getByRole("button", { name: "К редактору", exact: true }).click();
    await expect(editor.locator(".cm-content")).toContainText("Несохранённый");
    await editor.getByRole("button", { name: "Сохранить", exact: true }).click();
    await expect.poll(() => readFile(join(root, "new.md"), "utf8")).toContain("# Новый документ");
    await page.evaluate(() => {
      const original = Storage.prototype.setItem;
      window.restoreDraftStorage = () => {
        Storage.prototype.setItem = original;
      };
      Storage.prototype.setItem = function (key, value) {
        if (key.includes("workspace-file-draft:"))
          throw new DOMException("Full", "QuotaExceededError");
        return original.call(this, key, value);
      };
    });
    await text("# Не потерять при заполненном хранилище");
    await editor.getByRole("button", { name: "Закрыть редактор", exact: true }).click();
    await editor.getByRole("button", { name: "Закрыть с черновиком", exact: true }).click();
    await expect(editor).toBeVisible();
    await expect(
      editor.getByRole("alert").filter({ hasText: "Не удалось сохранить черновик" }),
    ).toBeVisible();
    await expect(editor.locator(".cm-content")).toContainText("Не потерять");
    await page.evaluate(() => window.restoreDraftStorage());
    await editor.getByRole("button", { name: "Не сохранять", exact: true }).click();
    await pane
      .getByRole("button", { name: /^preview.html/ })
      .first()
      .click();
    await edit();
    await text("<h1>Черновик HTML</h1>");
    await editor.getByRole("button", { name: "Предпросмотр", exact: true }).click();
    await expect(viewer.locator("iframe")).toHaveAttribute("sandbox", "allow-scripts");
    await expect(
      viewer.frameLocator("iframe").getByRole("heading", { name: "Черновик HTML" }),
    ).toBeVisible();
    assert.equal(await readFile(join(root, "preview.html"), "utf8"), "<h1>Исходная страница</h1>");
    await viewer.getByRole("button", { name: "К редактору", exact: true }).click();
    await editor.getByRole("button", { name: "Закрыть редактор", exact: true }).click();
    await editor.getByRole("button", { name: "Не сохранять", exact: true }).click();
    const deleteIds = [];
    let loseDelete = true;
    await page.route("**/api/projects/project/file-tools", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      deleteIds.push(route.request().postDataJSON().id);
      if (loseDelete) {
        loseDelete = false;
        await route.fetch();
        await route.abort("failed");
      } else await route.continue();
    });
    await pane.getByRole("button", { name: "Действия: new.md", exact: true }).click();
    await action.getByRole("button", { name: "Удалить", exact: true }).click();
    await expect(action).toContainText("Удалить «new.md»");
    await action.getByRole("button", { name: "Удалить", exact: true }).click();
    await expect(
      action.getByRole("button", { name: "Проверить файловую операцию", exact: true }),
    ).toBeVisible();
    await page.reload();
    await open();
    await unlock();
    await pane.getByRole("button", { name: "Проверить файловую операцию", exact: true }).click();
    await expect(
      pane.getByRole("button", { name: "Проверить файловую операцию", exact: true }),
    ).toHaveCount(0);
    await expect(pane.getByRole("button", { name: "Действия: new.md", exact: true })).toHaveCount(
      0,
    );
    assert.equal(deleteIds.length, 2);
    assert.equal(deleteIds[0], deleteIds[1]);
    assert.deepEqual(errors, []);
    console.log(
      engine + ": editor save/conflict/lost-ack/reload/drafts/relock/files/themes passed",
    );
  } finally {
    await browser.close();
    await f.close();
    await rm(root, { recursive: true, force: true });
  }
}
