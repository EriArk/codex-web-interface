import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect, webkit } from "@playwright/test";
import { handoffFixture } from "./handoff-fixture.mjs";

await mkdir(".local/qa-project-upload", { recursive: true });
for (const [engine, type] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
  const root = await mkdtemp(join(tmpdir(), "project-upload-browser-")),
    origin = "http://127.0.0.1:18877",
    f = await handoffFixture(origin);
  f.sessions.config.machines[0].type = "local-linux";
  f.sessions.config.projects[0].workingDirectory = root;
  f.sessions.config.projects[0].name =
    "Очень длинное название проекта — файлы и рабочие материалы команды";
  f.store.setPreferences({
    projectId: "project",
    threadId: f.thread.id,
    theme: "crt-green",
    view: "chat",
    machineClients: { pc: "web" },
  });
  await mkdir(join(root, "target"));
  await writeFile(join(root, "target/same.txt"), "old");
  const browser = await type.launch(),
    context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      serviceWorkers: "block",
    });
  try {
    await f.app.listen({ host: "127.0.0.1", port: 18877 });
    const [name, value] = f.headers.cookie.split("=");
    await context.addCookies([{ name, value, url: origin }]);
    const page = await context.newPage(),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(origin);
    const composer = page.getByLabel("Сообщение Codex", { exact: true });
    await expect(composer).toBeVisible();
    await composer.fill("Не потерять этот чат");
    const pane = page.locator(".project-files[open]"),
      popup = page.getByRole("dialog", { name: "Загрузка файлов", exact: true }),
      picker = popup.getByLabel("Выбрать файлы для загрузки");
    const open = async () => {
      await page.getByRole("button", { name: "Файлы проекта", exact: true }).click();
      await pane
        .getByRole("button", { name: /^target/ })
        .first()
        .click();
      await pane.getByRole("button", { name: "Разблокировать файлы", exact: true }).click();
      await pane.getByRole("button", { name: /^Загрузить файлы/ }).click();
      await expect(popup).toBeVisible();
    };
    const select = async (name, bytes) => {
      await picker.setInputFiles({ name, mimeType: "application/octet-stream", buffer: bytes });
    };
    const start = () => popup.getByRole("button", { name: "Загрузить", exact: true }).click();
    const row = (name) => popup.getByRole("region", { name, exact: true });
    await open();
    await picker.dispatchEvent("cancel", { bubbles: true });
    await expect(popup).toBeVisible();
    await expect(pane).toBeVisible();
    await picker.setInputFiles([
      {
        name: "binary.bin",
        mimeType: "application/octet-stream",
        buffer: Buffer.from([0, 255, 3]),
      },
      { name: "empty.bin", mimeType: "application/octet-stream", buffer: Buffer.alloc(0) },
    ]);
    await start();
    await expect(row("binary.bin")).toContainText("Загружен");
    await expect(row("empty.bin")).toContainText("Загружен");
    assert.deepEqual(await readFile(join(root, "target/binary.bin")), Buffer.from([0, 255, 3]));
    assert.equal((await stat(join(root, "target/empty.bin"))).size, 0);
    await select("same.txt", Buffer.from("new bytes"));
    await start();
    await expect(row("same.txt")).toContainText("Файл с таким именем");
    assert.equal(await readFile(join(root, "target/same.txt"), "utf8"), "old");
    for (const theme of ["crt-green", "hitech-2000s", "organizer", "classic-dark"])
      for (const [width, height] of [
        [390, 844],
        [390, 430],
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
        await expect(popup.getByRole("button", { name: "Закрыть загрузку" })).toBeVisible();
        await page.screenshot({
          path: `.local/qa-project-upload/${engine}-${theme}-${width}-${height}.png`,
          animations: "disabled",
        });
      }
    await page.setViewportSize({ width: 390, height: 844 });
    await row("same.txt").getByRole("button", { name: "Заменить старый", exact: true }).click();
    await writeFile(join(root, "target/same.txt"), "changed after choice");
    await start();
    await expect(row("same.txt")).toContainText("изменился");
    assert.equal(await readFile(join(root, "target/same.txt"), "utf8"), "changed after choice");
    await row("same.txt").getByRole("button", { name: "Заменить старый", exact: true }).click();
    await start();
    await expect(row("same.txt")).toContainText("Загружен");
    assert.equal(await readFile(join(root, "target/same.txt"), "utf8"), "new bytes");
    await select("same.txt", Buffer.from("another"));
    await start();
    await row("same.txt").getByRole("button", { name: "Другое имя", exact: true }).click();
    await expect(popup.getByLabel("Имя: same.txt")).toHaveValue("same (копия).txt");
    await start();
    await expect(row("same (копия).txt")).toContainText("Загружен");
    assert.equal(await readFile(join(root, "target/same (копия).txt"), "utf8"), "another");
    assert.equal(await readFile(join(root, "target/same.txt"), "utf8"), "new bytes");
    await select("same.txt", Buffer.from("skip"));
    await start();
    await row("same.txt").getByRole("button", { name: "Пропустить", exact: true }).click();
    await expect(row("same.txt")).toContainText("Пропущен");
    let lose = true;
    const ids = [];
    await page.route("**/file-uploads/*/complete", async (route) => {
      ids.push(route.request().url());
      if (lose) {
        lose = false;
        await route.fetch();
        await route.abort("failed");
      } else await route.continue();
    });
    await select("receipt.bin", Buffer.from("one commit"));
    await start();
    await expect(
      row("receipt.bin").getByRole("button", { name: "Продолжить / проверить", exact: true }),
    ).toBeVisible();
    const before = (await stat(join(root, "target/receipt.bin"))).mtimeMs;
    await page.reload();
    await expect(composer).toHaveValue("Не потерять этот чат");
    await open();
    await row("receipt.bin")
      .getByRole("button", { name: "Продолжить / проверить", exact: true })
      .click();
    await expect(row("receipt.bin")).toContainText("Загружен");
    assert.equal(ids.length, 1);
    assert.equal((await stat(join(root, "target/receipt.bin"))).mtimeMs, before);
    await page.unroute("**/file-uploads/*/complete");
    let interruptChunk = true;
    await page.route("**/file-uploads/*?offset=*", async (route) => {
      if (interruptChunk && route.request().url().endsWith("offset=4194304")) {
        interruptChunk = false;
        await route.abort("failed");
      } else await route.continue();
    });
    const large = Buffer.alloc(4 * 1024 * 1024 + 10, 9);
    await select("resume.bin", large);
    await start();
    await expect(
      row("resume.bin").getByRole("button", { name: "Продолжить / проверить", exact: true }),
    ).toBeVisible();
    await page.reload();
    await open();
    const wrongChooser = page.waitForEvent("filechooser");
    await row("resume.bin").getByRole("button", { name: "Выбрать снова", exact: true }).click();
    await (await wrongChooser).setFiles({
      name: "resume.bin",
      mimeType: "application/octet-stream",
      buffer: Buffer.alloc(large.length, 8),
    });
    await start();
    await expect(row("resume.bin")).toContainText("Повторный фрагмент отличается");
    await assert.rejects(stat(join(root, "target/resume.bin")), { code: "ENOENT" });
    await page.unroute("**/file-uploads/*?offset=*");
    const rightChooser = page.waitForEvent("filechooser");
    await row("resume.bin").getByRole("button", { name: "Выбрать снова", exact: true }).click();
    await (await rightChooser).setFiles({
      name: "resume.bin",
      mimeType: "application/octet-stream",
      buffer: large,
    });
    await start();
    await expect(row("resume.bin")).toContainText("Загружен");
    assert.deepEqual(await readFile(join(root, "target/resume.bin")), large);
    let reached, release;
    const reachedPromise = new Promise((r) => (reached = r)),
      held = new Promise((r) => (release = r));
    await page.route("**/file-uploads/*?offset=*", async (route) => {
      reached();
      await held;
      await route.abort("failed").catch(() => {});
    });
    await select("cancel.bin", Buffer.alloc(100, 4));
    await start();
    await reachedPromise;
    await row("cancel.bin").getByRole("button", { name: "Отменить", exact: true }).click();
    release();
    await expect(row("cancel.bin")).toContainText("Пропущен");
    await assert.rejects(stat(join(root, "target/cancel.bin")), { code: "ENOENT" });
    await page.unroute("**/file-uploads/*?offset=*");
    await popup.getByRole("button", { name: "Закрыть загрузку", exact: true }).click();
    await expect(pane).toBeVisible();
    await pane.getByRole("button", { name: "Закрыть файлы", exact: true }).click();
    await expect(composer).toHaveValue("Не потерять этот чат");
    assert.deepEqual(errors, []);
    console.log(
      engine +
        ": uploads, conflicts, rename, skip, lost ack, prefix integrity, cancellation and themes passed",
    );
  } catch (error) {
    const page = context.pages()[0];
    if (page) {
      await page.screenshot({ path: `.local/qa-project-upload/${engine}-failure.png` });
      console.log(
        await page
          .locator("dialog[open]")
          .evaluateAll((nodes) =>
            nodes.map((n) => ({
              label: n.getAttribute("aria-label"),
              text: n.textContent?.slice(-1800),
            })),
          ),
      );
    }
    throw error;
  } finally {
    await browser.close();
    await f.close();
    await rm(root, { recursive: true, force: true });
  }
}
