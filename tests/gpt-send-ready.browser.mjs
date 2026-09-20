import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, expect, webkit } from "@playwright/test";
import react from "../apps/web/node_modules/@vitejs/plugin-react/dist/index.js";
import { build } from "../apps/web/node_modules/vite/dist/node/index.js";

const dir = await mkdtemp(join(tmpdir(), "gpt-send-ready-"));
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
        name: "GptOutboxFixture",
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

  await mkdir(".local/qa-gpt-send-ready", { recursive: true });
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
      let releaseHistory,
        releaseModels,
        reads = 0,
        sends = 0;
      const page = await context.newPage();
      await page.addInitScript(() => localStorage.setItem("gpt-conversation", "history-chat"));
      await page.clock.install();
      await page.route("https://outbox.test/**", async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === "/fixture.js")
          return route.fulfill({ contentType: "application/javascript", body: js });
        if (path === "/fixture.css") return route.fulfill({ contentType: "text/css", body: css });
        if (path === "/")
          return route.fulfill({
            contentType: "text/html",
            body: '<!doctype html><meta charset="utf-8"><div id="root"></div><link rel="stylesheet" href="/fixture.css"><script src="/fixture.js"></script>',
          });
        if (path === "/api/gpt/status")
          return route.fulfill({ json: { configured: true, canSend: true, state: "healthy" } });
        if (path === "/api/gpt/models") {
          await new Promise((resolve) => {
            releaseModels = resolve;
          });
          return route.fulfill({
            json: {
              models: [{ id: "latest", label: "Latest" }],
              efforts: [{ id: "0", label: "Instant" }],
              currentModel: "latest",
              currentEffort: "0",
            },
          });
        }
        if (path.endsWith("/history-chat/messages")) {
          reads++;
          await new Promise((resolve) => {
            releaseHistory = resolve;
          });
          return route.fulfill({
            json: {
              items: [
                { id: "reply", role: "assistant", text: "Saved reply", createdAt: 1, files: [] },
              ],
              nextBefore: null,
              revision: "v1",
            },
          });
        }
        if (path === "/api/gpt/send") sends++;
        return route.fulfill({
          json: { items: [], conversations: [], nextOffset: null, stamp: Date.now() },
        });
      });
      await page.goto("https://outbox.test/");
      const editor = page.getByRole("textbox", { name: "Сообщение GPT" });
      const button = page.locator(".gpt-composer button[type=submit]");
      await expect(editor).toBeVisible();
      await editor.fill("Draft while the chat loads");
      await expect(button).toBeDisabled();
      await expect(button).toHaveAttribute("aria-busy", "true");
      await expect(button.locator(".spinner")).toBeVisible();
      await page
        .locator(".gpt-composer")
        .evaluate((form) =>
          form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
        );
      assert.equal(sends, 0);
      await expect.poll(() => !!releaseHistory && !!releaseModels).toBe(true);
      releaseHistory();
      await expect(page.getByText("Saved reply", { exact: true })).toBeVisible();
      await expect(button).toBeDisabled();
      releaseModels();
      await expect(button).toBeEnabled();
      await expect(button.locator(".spinner")).toHaveCount(0);
      await expect(editor).toHaveValue("Draft while the chat loads");
      await page.clock.fastForward(16000);
      await expect.poll(() => reads).toBe(2);
      await expect(button).toBeEnabled();
      await expect(button.locator(".spinner")).toHaveCount(0);
      releaseHistory();
      await page.screenshot({ path: `.local/qa-gpt-send-ready/${name}.png` });
      assert.equal(sends, 0);
      console.log(
        name +
          ": visible draft and send ring until history/models ready; background refresh does not block; no premature send",
      );
    } finally {
      await context.close();
      await browser.close();
    }
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}
