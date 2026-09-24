import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, stat, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, expect, webkit } from "@playwright/test";
import { handoffFixture } from "./handoff-fixture.mjs";

await mkdir(".local/qa-artifact-navigation", { recursive: true });
for (const [engine, type] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
  const origin = "http://127.0.0.1:18859",
    f = await handoffFixture(origin);
  const browser = await type.launch(),
    context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      serviceWorkers: "block",
    });
  try {
    f.store.db.prepare("UPDATE threads SET origin='web' WHERE id=?").run(f.thread.id);
    f.store.setPreferences({
      projectId: "project",
      threadId: f.thread.id,
      theme: "crt-green",
      machineClients: { pc: "web" },
    });
    const text =
      "[Первая версия](C:/Users/Test/AppData/Local/report.md)\n\n![Точное изображение](C:/Project/exact.png)\n\n[Нет файла](missing.md)\n\n[Архив](case.zip)\n\n[Внешний сайт](https://example.com/file.zip)";
    f.store.append(f.thread.id, "assistant.completed", { id: "answer", text }, "turn");
    const captures = f.sessions.catalog.artifacts;
    captures.read = async (_m, _root, path) =>
      Buffer.from(path.endsWith("zip") ? "PK fixture" : "# Original snapshot\n");
    captures.observe(f.thread, "turn", {
      id: "answer",
      type: "agentMessage",
      text: "[First](C:/Users/Test/AppData/Local/report.md) [Archive](case.zip)",
    });
    await captures.close();
    const archive = f.store.db
      .prepare("SELECT * FROM artifact_captures WHERE name='case.zip'")
      .get();
    await truncate(join(captures.artifacts.root, archive.artifactId + ".bin"), 400 * 1024 * 1024);
    f.store.db
      .prepare("UPDATE artifacts SET bytes=? WHERE id=?")
      .run(400 * 1024 * 1024, archive.artifactId);
    f.sessions.catalog.observeImages(f.thread, "turn", {
      id: "answer",
      type: "agentMessage",
      text,
    });
    // A different turn with the same filename must not replace the clicked snapshot.
    captures.read = async () => Buffer.from("# Wrong later version");
    captures.observe(f.thread, "later", {
      id: "later-answer",
      type: "agentMessage",
      text: "[Later](C:/Users/Test/AppData/Local/report.md)",
    });
    await captures.close();
    await f.app.listen({ port: 18859, host: "127.0.0.1" });
    const [name, value] = f.headers.cookie.split("=");
    await context.addCookies([{ name, value, url: origin, httpOnly: true, sameSite: "Strict" }]);
    const page = await context.newPage();
    const png = Buffer.from(
      await page.evaluate(() => {
        const canvas = document.createElement("canvas");
        canvas.width = 320;
        canvas.height = 180;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#57a";
        ctx.fillRect(0, 0, 320, 180);
        return canvas.toDataURL("image/png").split(",")[1];
      }),
      "base64",
    );
    await page.route("**/api/native-images/*", (route) =>
      route.fulfill({ contentType: "image/png", body: png }),
    );
    let navigations = 0,
      archiveGets = 0;
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) navigations++;
    });
    context.on("request", (request) => {
      if (request.url().includes(archive.artifactId) && request.method() === "GET") archiveGets++;
    });
    await page.goto(origin);
    const editor = page.getByRole("textbox", { name: "Сообщение Codex" });
    await expect(editor).toBeVisible();
    const inlineImage = page.locator(".message-generated-image img").first();
    await expect(inlineImage).toBeVisible();
    await expect
      .poll(() => inlineImage.evaluate((node) => node.complete && node.naturalWidth > 0))
      .toBe(true);
    await inlineImage.evaluate((node) => {
      window.originalInlineImage = node;
    });
    let imageReveals = 0;
    page.on("request", (request) => {
      if (
        request.url().endsWith("/results/reveal") &&
        request.postDataJSON()?.source === "C:/Project/exact.png"
      )
        imageReveals++;
    });
    // Exercise fresh callback props, unrelated live output and changed Markdown.
    // All must preserve the loaded image, including across completion updates.
    for (let i = 0; i < 5; i++) {
      const updated = f.store.append(
        f.thread.id,
        "assistant.completed",
        {
          id: "answer",
          text: text + `\n\nUpdate ${i}`,
        },
        "turn",
      );
      f.sessions.emit("event", updated);
      await expect(page.locator(".message-body").filter({ hasText: `Update ${i}` })).toBeAttached();
      assert(
        await inlineImage.evaluate((node) => node === window.originalInlineImage && node.complete),
      );
    }
    assert.equal(imageReveals, 0, "updates must not resolve an unchanged image again");
    await editor.fill("Черновик остаётся здесь");
    await page
      .locator('input[type="file"]')
      .first()
      .setInputFiles({
        name: "draft.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("keep attachment"),
      });
    await expect(page.getByRole("button", { name: "Удалить draft.txt" })).toBeVisible();
    await editor.evaluate((node) => {
      window.originalEditor = node;
    });
    const results = page.getByRole("region", { name: "Результаты", exact: true });
    const chat = () =>
      page.locator(".mobile-tabs").getByRole("button", { name: "Чат", exact: true }).click();
    for (const viewport of [
      { width: 390, height: 844 },
      { width: 1366, height: 1024 },
      { width: 1920, height: 1080 },
    ]) {
      await page.setViewportSize(viewport);
      if (viewport.width === 390) await chat();
      await page.getByRole("button", { name: "Первая версия", exact: true }).click();
      await expect(page.locator(".file-viewer-dialog")).toContainText("Original snapshot");
      const live = f.store.append(
        f.thread.id,
        "assistant.delta",
        { id: "live", text: `Продолжение ${viewport.width}. `, phase: "commentary" },
        "stream-turn",
      );
      f.sessions.emit("event", live);
      await expect(
        page.locator(".message-body").filter({ hasText: `Продолжение ${viewport.width}.` }),
      ).toBeAttached();
      await expect(page.locator(".file-viewer-dialog")).not.toContainText("Wrong later version");
      await page.getByRole("button", { name: "Закрыть просмотр" }).click();
      if (viewport.width === 390) await chat();
      await page.getByRole("button", { name: "Точное изображение", exact: true }).click();
      await expect(page.locator(".file-viewer-dialog img")).toBeVisible();
      await expect(page.locator(".file-viewer-heading")).toContainText("exact.png");
      await page.getByRole("button", { name: "Закрыть просмотр" }).click();
      if (viewport.width === 390) await chat();
      await page.getByRole("button", { name: "Нет файла", exact: true }).click();
      await expect(page.locator(".file-viewer-dialog [role=status]")).toContainText("не найдены");
      await page.getByRole("button", { name: "Закрыть просмотр" }).click();
      if (viewport.width === 390) await chat();
      await expect(editor).toHaveValue("Черновик остаётся здесь");
      await expect(page.getByRole("button", { name: "Удалить draft.txt" })).toBeAttached();
      assert(await editor.evaluate((node) => node === window.originalEditor));
      assert.equal(navigations, 1);
      assert.equal(context.pages().length, 1);
      await page.screenshot({
        path: `.local/qa-artifact-navigation/${engine}-${viewport.width}.png`,
      });
    }
    await page.evaluate(() => {
      window.openedLinks = [];
      window.open = (...args) => {
        window.openedLinks.push(args);
        return null;
      };
    });
    await page.locator('a[href="https://example.com/file.zip"]').click();
    const opened = await page.evaluate(() => window.openedLinks);
    assert.equal(opened.length, 1);
    assert.equal(opened[0][0], "https://example.com/file.zip");
    assert.match(opened[0][2], /popup=yes.*noopener,noreferrer/);
    assert.equal(navigations, 1);
    if (!process.env.ARTIFACT_LINKS_ONLY) {
      await page.getByRole("button", { name: "Архив", exact: true }).click();
      const viewer = page.locator(".file-viewer-dialog");
      await expect(viewer).toBeVisible();
      assert.equal(archiveGets, 0, "unsupported large binary is not preloaded");
      const downloadEvent = page.waitForEvent("download");
      await viewer.getByRole("link", { name: "Скачать файл", exact: true }).click();
      const download = await downloadEvent;
      assert.equal(download.suggestedFilename(), "case.zip");
      assert.equal((await stat(await download.path())).size, 400 * 1024 * 1024);
      assert.equal(navigations, 1);
      assert(await editor.evaluate((node) => node === window.originalEditor));
    }
    assert.equal(
      f.calls.filter((call) => ["turn/start", "thread/resume"].includes(call.method)).length,
      0,
    );
    console.log(
      `${engine}: exact snapshots/images, unavailable reference, phone/tablet/desktop draft+attachment continuity and link routing passed (large download optional)`,
    );
  } finally {
    await context.close();
    await browser.close();
    await f.close();
  }
}
