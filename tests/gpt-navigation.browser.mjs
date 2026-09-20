import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, expect, webkit } from "@playwright/test";
import react from "../apps/web/node_modules/@vitejs/plugin-react/dist/index.js";
import { build } from "../apps/web/node_modules/vite/dist/node/index.js";

const dir = await mkdtemp(join(tmpdir(), "gpt-navigation-"));
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

  for (const [name, type] of [
    ["chromium", chromium],
    ["webkit", webkit],
  ]) {
    const browser = await type.launch();
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      serviceWorkers: "block",
    });
    try {
      const page = await context.newPage();
      await page.addInitScript(() => localStorage.setItem("gpt-conversation", "history-chat"));
      await page.clock.install();
      let catalogReads = 0,
        offline = false,
        reveal;
      const content =
        Array.from(
          { length: 220 },
          (_, i) =>
            `## Section ${i}\n\nA **long response** with [source ${i}](https://example.org/${i}) and a list:\n\n- first\n- second\n`,
        ).join("\n") + "\n[Exact file](sandbox:/mnt/data/report.txt)";
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
        if (path === "/api/gpt/conversations" || path === "/api/gpt/projects") catalogReads++;
        if (offline) return route.abort();
        if (path === "/api/gpt/status")
          return route.fulfill({ json: { configured: true, canSend: true, state: "healthy" } });
        if (path === "/api/gpt/models")
          return route.fulfill({
            json: {
              models: [{ id: "latest", label: "Latest" }],
              efforts: [{ id: "0", label: "Instant" }],
              currentModel: "latest",
              currentEffort: "0",
            },
          });
        if (path === "/api/gpt/conversations")
          return route.fulfill({
            json: {
              items: Array.from({ length: 20 }, (_, i) => ({
                id: i ? `chat-${i}` : "history-chat",
                title: `Chat ${i}`,
                updatedAt: i,
              })),
              nextOffset: 20,
            },
          });
        if (path.endsWith("/messages"))
          return route.fulfill({
            json: {
              items: [{ id: "reply", role: "assistant", text: content, createdAt: 1, files: [] }],
              nextBefore: null,
              revision: "v1",
            },
          });
        if (path.endsWith("/results/reveal")) {
          reveal = route.request().postDataJSON();
          return route.fulfill({
            status: 404,
            json: { error: { message: "Unavailable fixture" } },
          });
        }
        return route.fulfill({
          json: { items: [], conversations: [], nextOffset: null, stamp: 1 },
        });
      });
      await page.goto("https://outbox.test/");
      const editor = page.locator(".gpt-composer textarea");
      await expect(page.locator('[data-message="reply"] a')).toHaveCount(220);
      await expect(page.locator(".gpt-composer button[type=submit]")).not.toHaveAttribute(
        "aria-busy",
        "true",
      );
      await editor.fill("Preserved draft");
      await page.evaluate(() => {
        window.savedLink = document.querySelector('[data-message="reply"] a');
        window.savedFile = document.querySelector('[data-message="reply"] .download-text');
      });
      const initialReads = catalogReads;
      offline = true;
      const drawer = page.locator("dialog.project-sheet"),
        durations = [];
      for (let i = 0; i < 3; i++) {
        const start = Date.now();
        await page.locator(".workspace-header > button").first().click();
        await expect(drawer).toBeVisible();
        await expect(drawer.getByText("Chat 0", { exact: true })).toBeVisible();
        durations.push(Date.now() - start);
        await drawer.locator("[data-drawer-close]").click();
        await page.clock.runFor(200);
        await expect(drawer).not.toBeVisible();
      }
      assert.equal(catalogReads, initialReads, "opening cached navigation must not fetch pages");
      assert.equal(
        await page.evaluate(
          () => window.savedLink === document.querySelector('[data-message="reply"] a'),
        ),
        true,
        "unchanged Markdown must retain its parsed link nodes",
      );
      assert.equal(
        await page.evaluate(
          () =>
            window.savedFile === document.querySelector('[data-message="reply"] .download-text'),
        ),
        true,
        "artifact link must not remount during navigation",
      );
      await expect(editor).toHaveValue("Preserved draft");
      offline = false;
      await page.locator('[data-message="reply"] .download-text').click();
      await expect.poll(() => reveal?.messageId).toBe("reply");
      assert.equal(reveal.source, "sandbox:/mnt/data/report.txt");
      // Safari may discard the tab and its short-lived history cache. Navigation
      // must still be usable while all native reads are unavailable.
      await page.clock.runFor(300);
      await page.evaluate(() => {
        window.dispatchEvent(new Event("pagehide"));
        const saved = JSON.parse(localStorage.getItem("gpt-navigation-cache-v1"));
        if (saved.items.length !== 20 || saved.offset !== 20 || "chats" in saved)
          throw new Error("Navigation snapshot must contain metadata and paging only");
        sessionStorage.clear();
      });
      offline = true;
      await page.reload();
      await page.locator(".workspace-header > button").first().click();
      await expect(drawer.getByText("Chat 0", { exact: true })).toBeVisible();
      await expect(drawer.getByText("Chat 19", { exact: true })).toBeAttached();
      await page.evaluate(() => window.dispatchEvent(new Event("private-session-ended")));
      assert.equal(
        await page.evaluate(() => localStorage.getItem("gpt-navigation-cache-v1")),
        null,
      );
      console.log(
        JSON.stringify({
          browser: name,
          cachedDrawer: true,
          unchangedMarkdown: true,
          exactArtifact: true,
          openMs: durations,
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
