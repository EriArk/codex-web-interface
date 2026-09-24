import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, expect, webkit } from "@playwright/test";
import react from "../apps/web/node_modules/@vitejs/plugin-react/dist/index.js";
import { build } from "../apps/web/node_modules/vite/dist/node/index.js";

const dir = await mkdtemp(join(tmpdir(), "results-artifacts-"));
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
        entry: resolve("apps/web/tests/fixtures/gpt-result-links.tsx"),
        name: "Fixture",
        formats: ["iife"],
        fileName: () => "fixture.js",
      },
    },
  });
  const js = await readFile(join(dir, "fixture.js"), "utf8"),
    css = (
      await Promise.all(
        (
          await readdir(dir)
        )
          .filter((n) => n.endsWith(".css"))
          .map((n) => readFile(join(dir, n), "utf8")),
      )
    ).join("\n");
  await mkdir(".local/qa-results-artifacts", { recursive: true });
  for (const [name, engine] of [
    ["chromium", chromium],
    ["webkit", webkit],
  ]) {
    const browser = await engine.launch(),
      context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        acceptDownloads: true,
      });
    let server;
    try {
      const page = await context.newPage(),
        failures = [];
      page.on("pageerror", (e) => failures.push(e.message));
      const textUrl = "/api/gpt/text-artifacts/" + "a".repeat(64),
        binaryUrl = "/api/gpt/assets/file-binary";
      const body = "Привет 👍\n" + "long-line-".repeat(20000);
      const common = { turnId: "m", createdAt: new Date(0).toISOString() };
      const text = {
        ...common,
        id: "text",
        type: "file",
        title: "Текст.md",
        payload: {
          url: textUrl,
          mime: "text/markdown",
          bytes: Buffer.byteLength(body),
          excerpt: "Привет 👍\nlong-line-…",
        },
      };
      const binary = {
        ...common,
        id: "binary",
        type: "file",
        title: "unknown.bin",
        payload: { url: binaryUrl, mime: "application/octet-stream", bytes: 3 },
      };
      const image = {
        ...common,
        id: "image",
        type: "image",
        title: "image.png",
        payload: { url: "/api/gpt/assets/file-image", mime: "image/png" },
      };
      const canvas = {
        ...common,
        id: "canvas",
        type: "canvas",
        title: "Target document",
        payload: { canvas: { id: "target", conversationId: "chat", version: 2 } },
      };
      const counts = { all: 3, files: 2, images: 1, links: 0, demos: 0, work: 0, reasoning: 0 };
      let reads = 0,
        failPreview = false,
        canvasBodyReads = 0;
      server = createServer((_req, response) => {
        reads++;
        response.writeHead(failPreview ? 503 : 200, {
          "content-type": "text/markdown; charset=utf-8",
          "content-disposition": 'attachment; filename="test.md"',
        });
        response.end(failPreview ? "unavailable" : body);
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const origin = "http://127.0.0.1:" + server.address().port;
      await context.route(origin + "/**", async (route) => {
        const url = new URL(route.request().url()),
          path = url.pathname;
        if (path === "/fixture.js")
          return route.fulfill({ contentType: "application/javascript", body: js });
        if (path === "/fixture.css") return route.fulfill({ contentType: "text/css", body: css });
        if (path === "/")
          return route.fulfill({
            contentType: "text/html",
            body: '<!doctype html><meta charset="utf-8"><div id="root"></div><link rel="stylesheet" href="/fixture.css"><script src="/fixture.js"></script>',
          });
        if (path.endsWith("/results"))
          return route.fulfill({
            json: {
              items: url.searchParams.get("category") === "images" ? [image] : [text, binary],
              counts,
              nextBefore: null,
            },
          });
        if (path.endsWith("/canvases")) {
          canvasBodyReads++;
          return route.fulfill({
            json: {
              items: [canvas],
              counts: { ...counts, all: 1, files: 1, images: 0 },
              nextBefore: null,
            },
          });
        }
        if (path === textUrl) return route.continue();
        if (path === binaryUrl)
          return route.fulfill({
            contentType: "application/octet-stream",
            headers: { "content-disposition": 'attachment; filename="unknown.bin"' },
            body: "BIN",
          });
        if (path === image.payload.url)
          return route.fulfill({
            contentType: "image/png",
            body: Buffer.from(
              "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=",
              "base64",
            ),
          });
        if (path === "/api/gpt/canvas") {
          canvasBodyReads++;
          assert.equal(url.searchParams.get("conversationId"), "chat");
          return route.fulfill({
            json: {
              items: ["other", "target"].map((id) => ({
                id,
                conversationId: "chat",
                title: id === "target" ? "Target document" : "Other document",
                type: "document",
                content: id + " exact content",
                version: 2,
                revision: "r",
              })),
            },
          });
        }
        if (path === "/api/gpt/workspace-operations") return route.fulfill({ json: { items: [] } });
        return route.fulfill({ json: {} });
      });
      await page.goto(origin + "/");
      const card = page.locator('[data-result="text"]');
      await expect(card).toBeVisible();
      await expect(page.locator('[data-result="canvas"]')).toHaveCount(0);
      assert.equal(reads, 0);
      assert.equal(canvasBodyReads, 0);
      for (const theme of ["organizer", "crt-green", "hitech-2000s", "classic-dark"]) {
        await page.evaluate((t) => {
          document.documentElement.dataset.theme = t;
          document.documentElement.dataset.caseColor =
            t === "hitech-2000s" ? "turquoise" : t === "classic-dark" ? "blue" : "green";
        }, theme);
        await page.waitForTimeout(150);
        await page.screenshot({
          animations: "disabled",
          path: `.local/qa-results-artifacts/${name}-${theme}-cards.png`,
        });
      }
      const downloadEvent = page.waitForEvent("download");
      await card.getByRole("link", { name: "Скачать", exact: true }).click();
      const download = await downloadEvent;
      assert.equal(await readFile(await download.path(), "utf8"), body);
      await expect(page.locator(".file-preview")).toHaveCount(0);
      await card.getByRole("button", { name: "Открыть Текст.md", exact: true }).click();
      await expect(page.locator(".result-inspector")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Предпросмотр", exact: true })).toHaveCount(0);
      await expect(page.locator(".file-text")).toContainText("Привет");
      await expect(
        page.getByText("Показано начало файла. Полная версия доступна для скачивания."),
      ).toBeVisible();
      for (const [theme, width, height] of [
        ["crt-green", 390, 844],
        ["hitech-2000s", 844, 390],
        ["organizer", 768, 1024],
        ["classic-dark", 1280, 800],
      ]) {
        await page.setViewportSize({ width, height });
        await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        await page.screenshot({ path: `.local/qa-results-artifacts/${name}-${theme}.png` });
      }
      await page.getByRole("button", { name: "Закрыть просмотр" }).click();
      await expect(
        page.locator('[data-result="binary"]').getByRole("button", { name: "Предпросмотр" }),
      ).toHaveCount(0);
      failPreview = true;
      await card.getByRole("button", { name: "Открыть Текст.md", exact: true }).click();
      await expect(
        page.getByText("Предпросмотр недоступен. Можно скачать исходный файл."),
      ).toBeVisible();
      await expect(
        page
          .locator(".file-viewer-dialog")
          .getByRole("link", { name: "Скачать файл", exact: true }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Закрыть просмотр" }).click();
      await page
        .locator(".result-filters")
        .getByRole("button", { name: /^Изображения/ })
        .click();
      await expect(page.locator(".screenshot-preview img")).toBeVisible();
      await expect(
        page.locator('[data-result="image"]').getByRole("link", { name: "Скачать" }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Открыть снимок", exact: true }).click();
      await expect(
        page.getByRole("button", { name: "Закрыть просмотр", exact: true }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Закрыть просмотр", exact: true }).click();
      await expect(page.locator(".screenshot-preview img")).toBeVisible();
      await expect(page.locator(".result-inspector")).toHaveCount(0);
      assert.equal(canvasBodyReads, 0, "Canvas must not be read in the background");
      assert.equal(failures.length, 0, failures.join("\n"));
      console.log(
        `${name}: exact direct download, explicit bounded preview, failure fallback, no Canvas reads, thumbnails and four responsive themes passed`,
      );
    } finally {
      await context.close();
      await browser.close();
      if (server) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
    }
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}
