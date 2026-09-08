import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, expect, webkit } from "@playwright/test";
import { gptHistory } from "../apps/hub/dist/gpt-history.js";
import { gptResults, resultPage } from "../apps/hub/dist/gpt-results.js";
import react from "../apps/web/node_modules/@vitejs/plugin-react/dist/index.js";
import { build } from "../apps/web/node_modules/vite/dist/node/index.js";

const dir = await mkdtemp(join(tmpdir(), "codex-download-browser-"));
const sharp = createRequire(new URL("../apps/hub/package.json", import.meta.url))("sharp");
const png = await sharp({ create: { width: 240, height: 160, channels: 3, background: "#80b7a1" } })
  .png()
  .toBuffer();
const raw = {
  current_node: "answer",
  mapping: {
    answer: {
      message: {
        id: "answer",
        author: { role: "assistant" },
        channel: "final",
        content: {
          content_type: "text",
          parts: [
            "[Markdown](sandbox:/mnt/data/test.md) [JSON](sandbox:/mnt/data/test.json) [TXT](sandbox:/mnt/data/test.txt)",
          ],
        },
        metadata: {
          attachments: [{ id: "file_image", name: "Изображение", mime_type: "image/png" }],
        },
      },
    },
  },
};
const messages = gptHistory(raw, "conversation"),
  results = gptResults("conversation", messages, null);
let failure = false,
  slow = false,
  reads = 0;
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://fixture"),
    path = url.pathname;
  const json = (value) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(value));
  };
  if (path === "/") {
    res.setHeader("Content-Type", "text/html");
    return res.end(
      '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script>',
    );
  }
  if (path === "/fixture.js" || path === "/fixture.css") {
    res.setHeader("Content-Type", path.endsWith("js") ? "application/javascript" : "text/css");
    return res.end(await readFile(join(dir, path.slice(1))));
  }
  if (/^\/fonts\/[a-zA-Z0-9._-]+\.woff2$/.test(path)) {
    res.setHeader("Content-Type", "font/woff2");
    return res.end(await readFile(resolve("apps/web/public" + path)));
  }
  if (path.startsWith("/api/gpt/downloads/") || path === "/api/gpt/assets/file_image") {
    reads++;
    if (slow) await new Promise((r) => setTimeout(r, 900));
    if (failure) {
      res.statusCode = 503;
      return json({ error: { message: "Expired" } });
    }
    if (path.includes("assets")) {
      res.setHeader("Content-Type", "image/png");
      return res.end(png);
    }
    const file = messages[0].files.find((f) => f.url === path);
    assert(file);
    res.setHeader("Content-Type", file.mime);
    res.setHeader(
      "Content-Disposition",
      "attachment; filename*=UTF-8''" + encodeURIComponent(file.name),
    );
    return res.end("original " + file.name + "\n  exact spaces\n");
  }
  if (path === "/api/gpt/status")
    return json({ configured: true, canSend: true, state: "healthy" });
  if (path === "/api/gpt/models")
    return json({
      models: [{ id: "Latest", label: "Latest" }],
      efforts: [{ id: "2", label: "High" }],
      currentModel: "Latest",
      currentEffort: "2",
    });
  if (path === "/api/gpt/jobs") return json({ items: [], stamp: 1 });
  if (path === "/api/gpt/conversations")
    return json({ items: [{ id: "conversation", title: "Download test" }], nextOffset: null });
  if (path.endsWith("/messages"))
    return json({
      items: messages,
      nextBefore: null,
      revision: "v1",
      prefix: "v1",
      notModified: false,
      retainOlder: false,
    });
  if (path.endsWith("/results"))
    return json(resultPage(results, url.searchParams.get("category") ?? "all"));
  return json({ items: [], projects: [], conversations: [], nextOffset: null });
});
try {
  await build({
    configFile: false,
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    root: resolve("apps/web"),
    plugins: [react()],
    logLevel: "error",
    build: {
      outDir: dir,
      emptyOutDir: true,
      lib: {
        entry: resolve("apps/web/tests/fixtures/gpt-outbox.tsx"),
        name: "DownloadFixture",
        formats: ["iife"],
        fileName: () => "fixture.js",
      },
    },
  });
  const css = (
    await Promise.all(
      (
        await readdir(dir)
      )
        .filter((f) => f.endsWith(".css"))
        .map((f) => readFile(join(dir, f), "utf8")),
    )
  ).join("\n");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(dir, "fixture.css"), css);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  await mkdir(".local/qa-downloads", { recursive: true });
  for (const [name, type] of [
    ["chromium", chromium],
    ["webkit", webkit],
  ]) {
    const browser = await type.launch(),
      ctx = await browser.newContext({
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        serviceWorkers: "block",
      });
    try {
      await ctx.addInitScript(() => {
        localStorage.setItem("gpt-conversation", "conversation");
        window.shared = [];
        window.cancelShare = true;
        Object.defineProperty(navigator, "canShare", { configurable: true, value: () => true });
        Object.defineProperty(navigator, "share", {
          configurable: true,
          value: async (data) => {
            if (window.cancelShare) throw new DOMException("Cancelled", "AbortError");
            const f = data.files[0];
            window.shared.push({
              name: f.name,
              type: f.type,
              bytes: Array.from(new Uint8Array(await f.arrayBuffer())),
              active: navigator.userActivation.isActive,
            });
          },
        });
        Object.defineProperty(navigator, "standalone", { value: true });
      });
      const page = await ctx.newPage();
      page.on("pageerror", (e) => console.error("Fixture page error:", e.message));
      await page.goto(origin);
      const initialUrl = page.url(),
        draft = page.locator("textarea");
      await expect(draft).toBeVisible();
      await draft.fill("Keep my draft");
      const md = page.getByRole("button", { name: "Markdown", exact: true });
      await expect(md).toBeVisible();
      failure = true;
      await md.tap();
      const dialog = page.getByRole("dialog", { name: "Сохранить файл" });
      await expect(dialog.getByRole("alert")).toContainText("Не удалось получить файл");
      failure = false;
      slow = true;
      await dialog.getByRole("button", { name: "Повторить", exact: true }).tap();
      await expect(dialog.getByRole("status")).toBeVisible();
      await dialog.getByRole("button", { name: "Закрыть сохранение" }).tap();
      await expect(dialog).toHaveCount(0);
      await expect(draft).toHaveValue("Keep my draft");
      await md.tap();
      const share = dialog.getByRole("button", { name: "Сохранить / поделиться" });
      await expect(share).toBeVisible();
      assert.equal(await page.evaluate(() => window.shared.length), 0);
      await share.tap();
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("alert")).toHaveCount(0);
      await page.evaluate(() => {
        window.cancelShare = false;
      });
      await share.tap();
      await expect.poll(() => page.evaluate(() => window.shared.length)).toBe(1);
      let shared = await page.evaluate(() => window.shared[0]);
      assert.equal(shared.name, "test.md");
      assert.equal(Buffer.from(shared.bytes).toString(), "original test.md\n  exact spaces\n");
      assert.equal(page.url(), initialUrl);
      assert.equal(ctx.pages().length, 1);
      await dialog.getByRole("button", { name: "Закрыть сохранение" }).tap();
      slow = false;
      await page.getByRole("button", { name: "Результаты", exact: true }).last().tap();
      await page.getByRole("button", { name: "Открыть снимок" }).tap();
      await page
        .locator(".result-inspector")
        .getByRole("button", { name: "Скачать", exact: true })
        .tap();
      await expect(share).toBeVisible();
      await page.screenshot({ path: `.local/qa-downloads/${name}-image.png` });
      await share.tap();
      await expect.poll(() => page.evaluate(() => window.shared.length)).toBe(2);
      shared = await page.evaluate(() => window.shared[1]);
      assert.equal(shared.name, "Изображение.png");
      assert.equal(shared.type, "image/png");
      assert.deepEqual(Buffer.from(shared.bytes), png);
      await dialog.getByRole("button", { name: "Закрыть сохранение" }).tap();
      await expect(page.locator(".result-inspector")).toBeVisible();
      await page.setViewportSize({ width: 1366, height: 1024 });
      await page
        .locator(".result-inspector")
        .getByRole("button", { name: "Скачать", exact: true })
        .click();
      await expect(share).toBeVisible();
      await dialog.getByRole("button", { name: "Закрыть сохранение" }).click();
      await page.evaluate(() =>
        Object.defineProperty(navigator, "canShare", { configurable: true, value: () => false }),
      );
      await page
        .locator(".result-inspector")
        .getByRole("button", { name: "Скачать", exact: true })
        .click();
      const downloading = page.waitForEvent("download");
      await dialog.getByRole("link", { name: "Скачать файл", exact: true }).click();
      const downloaded = await downloading;
      assert.equal(downloaded.suggestedFilename(), "Изображение.png");
      assert.equal(page.url(), initialUrl);
      await dialog.getByRole("button", { name: "Закрыть сохранение" }).click();
      console.log(
        `${name}: GPT sandbox link, retry, slow-close, cancelled share, exact image/text files, phone/tablet return and download fallback passed`,
      );
    } finally {
      await ctx.close();
      await browser.close();
    }
  }
} finally {
  await new Promise((r) => server.close(r));
  await rm(dir, { recursive: true, force: true });
}
