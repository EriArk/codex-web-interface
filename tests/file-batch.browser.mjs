import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect, webkit } from "@playwright/test";
import { handoffFixture } from "./handoff-fixture.mjs";

await mkdir(".local/qa-file-batch", { recursive: true });
for (const [engine, type] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
  const root = await mkdtemp(join(tmpdir(), "file-batch-browser-")),
    origin = "http://127.0.0.1:18878",
    f = await handoffFixture(origin);
  f.sessions.config.machines[0].type = "local-linux";
  f.sessions.config.projects[0].workingDirectory = root;
  f.sessions.config.projects[0].name = "Очень длинное название проекта — рабочие файлы команды";
  f.store.setPreferences({
    projectId: "project",
    threadId: f.thread.id,
    theme: "crt-green",
    view: "chat",
    machineClients: { pc: "web" },
  });
  for (const folder of ["source/sub", "target", "moved"])
    await mkdir(join(root, folder), { recursive: true });
  for (const [file, bytes] of [
    ["source/a.txt", "alpha"],
    ["source/b.txt", "beta"],
    ["source/sub/c.txt", "nested"],
    ["target/a.txt", "existing"],
  ])
    await writeFile(join(root, file), bytes);
  const browser = await type.launch(),
    context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      serviceWorkers: "block",
    });
  try {
    await f.app.listen({ host: "127.0.0.1", port: 18878 });
    const [name, value] = f.headers.cookie.split("=");
    await context.addCookies([{ name, value, url: origin }]);
    const page = await context.newPage(),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(origin);
    const composer = page.getByLabel("Сообщение Codex", { exact: true });
    await expect(composer).toBeVisible();
    await composer.fill("Сохранить черновик чата");
    const pane = page.locator(".project-files[open]"),
      popup = page.getByRole("dialog", { name: "Групповая операция", exact: true }),
      controls = pane.getByRole("region", { name: "Выбор и групповые действия" });
    const open = async () => {
      await page.getByRole("button", { name: "Файлы проекта", exact: true }).click();
      await pane.getByRole("button", { name: "Разблокировать файлы", exact: true }).click();
    };
    const folder = async (path) => {
      await pane.getByRole("button", { name: "Ввести путь", exact: true }).click();
      await pane.getByLabel("Путь в проекте").fill(path);
      await pane.getByRole("button", { name: "Открыть папку", exact: true }).click();
      await expect(pane.locator(".inspector-entry").first()).toBeVisible();
    };
    const select = (path) =>
      pane.getByRole("checkbox", { name: `Выбрать: ${path}`, exact: true }).check();
    const start = () => popup.getByRole("button", { name: "Выполнить", exact: true }).click();
    const row = (path) => popup.getByRole("region", { name: path, exact: true });
    const finish = () => popup.getByRole("button", { name: "Завершить", exact: true }).click();
    await open();
    await folder("source");
    await controls.getByRole("button", { name: /^Выбрать несколько/ }).click();
    await select("source/a.txt");
    await select("source/sub");
    await folder("source/sub");
    await select("source/sub/c.txt");
    await expect(controls.getByRole("button", { name: /^Готово/ })).toContainText("3");
    for (const theme of ["crt-green", "organizer", "hitech-2000s", "classic-dark"]) {
      await page.evaluate((value) => (document.documentElement.dataset.theme = value), theme);
      await controls.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: `.local/qa-file-batch/${engine}-selection-${theme}.png`,
        animations: "disabled",
      });
    }
    await controls.getByRole("button", { name: "Копировать", exact: true }).click();
    await folder("target");
    await controls.getByRole("button", { name: /^Вставить сюда/ }).click();
    await expect(popup).toContainText("Копирование · 2");
    const mutations = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().endsWith("/file-tools"))
        mutations.push(request.postDataJSON());
    });
    await start();
    await expect(row("source/sub")).toContainText("Готово");
    await expect(row("source/a.txt")).toContainText("уже существует");
    assert.equal(await readFile(join(root, "target/a.txt"), "utf8"), "existing");
    assert.equal(await readFile(join(root, "target/sub/c.txt"), "utf8"), "nested");
    for (const theme of ["crt-green", "organizer", "hitech-2000s", "classic-dark"])
      for (const [width, height] of [
        [390, 430],
        [390, 844],
        [768, 1024],
        [1366, 1024],
      ]) {
        await page.setViewportSize({ width, height });
        await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
        await expect
          .poll(async () => {
            const b = await popup.boundingBox();
            return (
              b.x >= 0 &&
              b.y >= 0 &&
              b.y + b.height <= height + 1 &&
              Math.abs(b.x - (width - b.x - b.width)) < 2
            );
          })
          .toBe(true);
        await expect(
          popup.getByRole("button", { name: "Закрыть групповую операцию" }),
        ).toBeVisible();
        await page.screenshot({
          path: `.local/qa-file-batch/${engine}-${theme}-${width}-${height}.png`,
          animations: "disabled",
        });
      }
    await page.setViewportSize({ width: 390, height: 844 });
    await row("source/a.txt").getByRole("button", { name: "Сохранить оба", exact: true }).click();
    await start();
    await expect(row("source/a.txt")).toContainText("Готово");
    await finish();
    assert.equal(await readFile(join(root, "target/a (копия).txt"), "utf8"), "alpha");
    assert.equal(mutations.filter((m) => m.path === "source/sub/c.txt").length, 0);
    // Exact move receipt after response loss and reload: the moved source is already absent.
    await folder("source");
    await controls.getByRole("button", { name: /^Выбрать несколько/ }).click();
    await select("source/a.txt");
    await select("source/b.txt");
    await controls.getByRole("button", { name: "Вырезать", exact: true }).click();
    await folder("target");
    await controls.getByRole("button", { name: /^Вставить сюда/ }).click();
    // Preserve collision handling for the first row; skip it and lose the successful second reply.
    await row("source/a.txt").getByRole("button", { name: "Пропустить", exact: true }).click();
    let lost = true;
    await page.route("**/file-tools", async (route) => {
      if (route.request().method() === "POST" && lost) {
        lost = false;
        const response = await route.fetch();
        assert.equal(response.status(), 200, await response.text());
        await route.abort("failed");
      } else await route.continue();
    });
    await start();
    await expect(
      row("source/b.txt").getByRole("button", { name: "Проверить результат" }),
    ).toBeVisible();
    await assert.rejects(stat(join(root, "source/b.txt")), { code: "ENOENT" });
    const before = (await stat(join(root, "target/b.txt"))).mtimeMs;
    const moveId = mutations.find((m) => m.op === "move" && m.path === "source/b.txt").id;
    await page.reload();
    await expect(composer).toHaveValue("Сохранить черновик чата");
    await open();
    await controls.getByRole("button", { name: /^Операция/ }).click();
    await expect(popup.getByRole("button", { name: "Выполнить", exact: true })).toBeDisabled();
    await row("source/b.txt").getByRole("button", { name: "Проверить результат" }).click();
    await expect(row("source/b.txt")).toContainText("Готово");
    assert.equal((await stat(join(root, "target/b.txt"))).mtimeMs, before);
    assert(mutations.filter((m) => m.op === "move").every((m) => m.id === moveId));
    await finish();
    await page.unroute("**/file-tools");
    // Destructive batch requires explicit confirmation and rejects changed source snapshots.
    await folder("target");
    await controls.getByRole("button", { name: /^Выбрать несколько/ }).click();
    await select("target/a.txt");
    await select("target/b.txt");
    await controls.getByRole("button", { name: "Удалить", exact: true }).click();
    assert.equal(await readFile(join(root, "target/b.txt"), "utf8"), "beta");
    await writeFile(join(root, "target/a.txt"), "external change");
    await popup.getByRole("button", { name: "Подтвердить удаление", exact: true }).click();
    await expect(row("target/a.txt")).toContainText("изменил");
    await expect(row("target/b.txt")).toContainText("Готово");
    assert.equal(await readFile(join(root, "target/a.txt"), "utf8"), "external change");
    await assert.rejects(stat(join(root, "target/b.txt")), { code: "ENOENT" });
    await row("target/a.txt").getByRole("button", { name: "Пропустить", exact: true }).click();
    await finish();
    // Cancel a review without executing its ready entries.
    await controls.getByRole("button", { name: "Снять выбор", exact: true }).click();
    await select("target/a.txt");
    await controls.getByRole("button", { name: "Удалить", exact: true }).click();
    await popup.getByRole("button", { name: "Отменить оставшиеся", exact: true }).click();
    assert.equal(await readFile(join(root, "target/a.txt"), "utf8"), "external change");
    // Without durable metadata no mutation may be sent.
    await page.evaluate(() => {
      window.batchStorageSet = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key.includes("file-batch:"))
          throw new DOMException("Storage full", "QuotaExceededError");
        return window.batchStorageSet.call(this, key, value);
      };
    });
    const countBefore = mutations.length;
    await controls.getByRole("button", { name: "Удалить", exact: true }).click();
    await expect(controls.getByRole("alert")).toContainText("Storage full");
    assert.equal(mutations.length, countBefore);
    await page.evaluate(() => {
      Storage.prototype.setItem = window.batchStorageSet;
      delete window.batchStorageSet;
    });
    await select("target/a (копия).txt");
    await controls.getByRole("button", { name: "Удалить", exact: true }).click();
    let reached, release;
    const arrived = new Promise((resolve) => {
        reached = resolve;
      }),
      gate = new Promise((resolve) => {
        release = resolve;
      });
    let hold = true;
    await page.route("**/file-tools", async (route) => {
      if (route.request().method() === "POST" && hold) {
        hold = false;
        const response = await route.fetch();
        assert.equal(response.status(), 200);
        reached();
        await gate;
        await route.fulfill({ response });
      } else await route.continue();
    });
    await popup.getByRole("button", { name: "Подтвердить удаление", exact: true }).click();
    await arrived;
    await popup.getByRole("button", { name: "Остановить после текущего", exact: true }).click();
    release();
    await expect(row("target/a.txt")).toContainText("Готово");
    await expect(row("target/a (копия).txt")).toContainText("Готов к выполнению");
    assert.equal(await readFile(join(root, "target/a (копия).txt"), "utf8"), "alpha");
    await popup.getByRole("button", { name: "Отменить оставшиеся", exact: true }).click();
    await page.unroute("**/file-tools");
    await controls.getByRole("button", { name: "Копировать", exact: true }).click();
    await controls.getByRole("button", { name: /^Вставить сюда/ }).click();
    await expect(row("target/a (копия).txt")).toContainText("Это исходный файл");
    await row("target/a (копия).txt")
      .getByRole("button", { name: "Сохранить оба", exact: true })
      .click();
    await start();
    await expect(row("target/a (копия).txt")).toContainText("Готово");
    assert.equal(await readFile(join(root, "target/a (копия) (копия).txt"), "utf8"), "alpha");
    await finish();
    await pane.getByRole("button", { name: "Закрыть файлы", exact: true }).click();
    await expect(composer).toHaveValue("Сохранить черновик чата");
    assert.deepEqual(errors, []);
    console.log(
      engine +
        ": batch selection, nesting, copy conflicts, move receipt recovery, confirmed delete, stale source and themes passed",
    );
  } catch (error) {
    const page = context.pages()[0];
    if (page) {
      await page.screenshot({ path: `.local/qa-file-batch/${engine}-failure.png` });
      console.log(await page.locator("dialog[open]").allTextContents());
    }
    throw error;
  } finally {
    await browser.close();
    await f.close();
    await rm(root, { recursive: true, force: true });
  }
}
