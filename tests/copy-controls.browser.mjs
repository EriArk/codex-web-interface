import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, expect, webkit } from "@playwright/test";
import react from "../apps/web/node_modules/@vitejs/plugin-react/dist/index.js";
import { build } from "../apps/web/node_modules/vite/dist/node/index.js";

const dir = await mkdtemp(join(tmpdir(), "codex-copy-"));
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
        entry: resolve("apps/web/tests/fixtures/copy-controls.tsx"),
        name: "CopyFixture",
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
          .filter((f) => f.endsWith(".css"))
          .map((f) => readFile(join(dir, f), "utf8")),
      )
    ).join("\n");
  await mkdir(".local/qa-copy", { recursive: true });
  for (const [name, type] of [
    ["chromium", chromium],
    ["webkit", webkit],
  ]) {
    const browser = await type.launch(),
      context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        serviceWorkers: "block",
      });
    try {
      const page = await context.newPage();
      page.on("pageerror", (e) => console.log("Fixture page error:", e.message));
      await page.route("https://copy.test/**", async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === "/fixture.js")
          return route.fulfill({ contentType: "application/javascript", body: js });
        if (path === "/fixture.css") return route.fulfill({ contentType: "text/css", body: css });
        if (/^\/fonts\/[a-zA-Z0-9._-]+\.woff2$/.test(path))
          return route.fulfill({
            contentType: "font/woff2",
            body: await readFile(resolve("apps/web/public" + path)),
          });
        if (path !== "/") return route.fulfill({ status: 404, body: "" });
        return route.fulfill({
          contentType: "text/html",
          body: '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script>',
        });
      });
      await page.goto("https://copy.test/");
      await page.evaluate(() => {
        window.copied = [];
        const original = navigator.clipboard.writeText.bind(navigator.clipboard);
        navigator.clipboard.writeText = (text) => {
          window.copied.push(text);
          return original(text);
        };
      });
      const message = page.locator(".message-meta .copy-button").first();
      await message.tap();
      await expect(message).toHaveAttribute("aria-label", "Скопировано");
      assert.match(await page.evaluate(() => window.copied.at(-1)), /\*\*Жирный\*\*/);
      const block = page.locator(".copyable-block .copy-button").first();
      await block.tap();
      await expect(block).toHaveAttribute("aria-label", "Скопировано");
      assert.equal(
        await page.evaluate(() => window.copied.at(-1)),
        "  const текст = '<&>copy';\n\tconsole.log(текст);\n\n",
      );
      assert.equal(
        await page.locator("details[open]").count(),
        0,
        "Copy must not expand the block",
      );
      await page.locator("summary").first().tap();
      await expect(page.locator("pre").first()).toBeVisible();
      await page.getByRole("button", { name: "Добавить часть ответа" }).tap();
      await message.tap();
      assert.match(await page.evaluate(() => window.copied.at(-1)), /Новая часть ответа\.$/);
      const buttons = page.locator(".copy-button");
      assert.equal(await buttons.count(), 4, "No control for an empty response");
      for (const theme of ["organizer", "crt-green", "hitech-2000s", "classic-dark"]) {
        await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
        for (const width of [390, 1366]) {
          await page.setViewportSize({ width, height: width === 390 ? 844 : 1024 });
          assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
          for (const button of await buttons.all()) {
            const box = await button.boundingBox();
            assert(box.width >= 44 && box.height >= 44);
          }
          if (name === "chromium")
            await page.screenshot({ path: `.local/qa-copy/${theme}-${width}.png` });
        }
      }
      await page.evaluate(() => {
        navigator.clipboard.writeText = () => Promise.reject(Error("denied"));
        const original = document.execCommand.bind(document);
        document.execCommand = (command) => {
          window.fallbackValue = document.activeElement.value;
          return original(command);
        };
      });
      await message.click();
      await expect(message).toHaveAttribute("aria-label", "Скопировано");
      assert.match(await page.evaluate(() => window.fallbackValue), /Новая часть ответа\.$/);
      assert.equal(await page.locator("textarea").count(), 1, "Temporary field removed");
      await expect(page.getByRole("textbox", { name: "Черновик" })).toHaveValue("Мой черновик");
      await page.evaluate(() => (document.execCommand = () => false));
      await message.click();
      await expect(message).toHaveAttribute("aria-label", "Не удалось скопировать");
      await expect(page.locator(".copy-error")).toBeVisible();
      console.log(
        JSON.stringify({
          browser: name,
          nativeClipboard: true,
          exactBlockWhitespace: true,
          collapsedCopy: true,
          streamUpdates: true,
          fallback: true,
          failureVisible: true,
          themes: 4,
        }),
      );
    } finally {
      await context.close();
      await browser.close();
    }
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}
