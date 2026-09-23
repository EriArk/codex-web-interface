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
      serviceWorkers: "block",
    });
  try {
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
      editor = page.locator(".file-editor[open]");
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
    await open();
    await expect(pane.getByRole("button", { name: "Редактировать", exact: true })).toHaveCount(0);
    await unlock();
    await edit();
    await expect(editor.locator(".cm-lineNumbers")).toBeVisible();
    await text("export const value = 2;\n");
    await editor.getByRole("button", { name: "Сохранить", exact: true }).click();
    await expect
      .poll(() => readFile(join(root, "sample.ts"), "utf8"))
      .toBe("export const value = 2;\r\n");
    assert.match(git("diff").toString(), /value = 2/);
    assert.equal(git("diff", "--cached").toString(), "");
    await text("export const value = 3;\n");
    await writeFile(join(root, "sample.ts"), "export const external = 9;\r\n");
    await editor.getByRole("button", { name: "Сохранить", exact: true }).click();
    await expect(editor.locator(".file-editor-conflict")).toContainText("external = 9");
    await expect(editor.locator(".cm-content")).toContainText("value = 3");
    assert.match(await readFile(join(root, "sample.ts"), "utf8"), /external = 9/);
    await editor
      .getByRole("button", {
        name: "Я сравнил — сохранить мой текст при следующем сохранении",
        exact: true,
      })
      .click();
    await editor.getByRole("button", { name: "Сохранить", exact: true }).click();
    await expect.poll(() => readFile(join(root, "sample.ts"), "utf8")).toContain("value = 3");
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
    await page.reload();
    await expect(composer).toHaveValue("Сохранить чат");
    await open();
    await unlock();
    await edit();
    await expect(editor.locator(".cm-content")).toContainText("value = 4");
    await editor.getByRole("button", { name: "Сохранить", exact: true }).click();
    await expect(editor.getByRole("button", { name: "Сохранить", exact: true })).toBeDisabled();
    assert.equal(sends, 2);
    await page.unroute("**/api/projects/project/file-tools");
    for (const theme of ["crt-green", "hitech-2000s", "organizer", "classic-dark"])
      for (const [width, height] of [
        [390, 500],
        [1024, 768],
      ]) {
        await page.setViewportSize({ width, height });
        await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
        await expect.poll(async () => {
          const box = await editor.boundingBox();
          return box.x >= 0 &&
            box.y >= 0 &&
            box.x + box.width <= width + 1 &&
            box.y + box.height <= height + 1;
        }).toBe(true);
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
    await editor.getByRole("button", { name: "Закрыть редактор", exact: true }).click();
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
