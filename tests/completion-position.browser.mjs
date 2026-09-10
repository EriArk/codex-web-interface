import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, expect, webkit } from "@playwright/test";
import react from "../apps/web/node_modules/@vitejs/plugin-react/dist/index.js";
import { build } from "../apps/web/node_modules/vite/dist/node/index.js";

const dir = await mkdtemp(join(tmpdir(), "completion-position-"));
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
        entry: resolve("apps/web/tests/fixtures/completion-position.tsx"),
        name: "CompletionFixture",
        formats: ["iife"],
        fileName: () => "fixture.js",
      },
    },
  });
  const js = await readFile(join(dir, "fixture.js"), "utf8");
  for (const [engine, type] of [
    ["chromium", chromium],
    ["webkit", webkit],
  ]) {
    const browser = await type.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } }),
        errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.route("https://completion.test/**", (r) =>
        r.fulfill({
          contentType: "text/html",
          body:
            '<!doctype html><meta charset="utf-8"><div id="root"></div><script>' + js + "</script>",
        }),
      );
      const open = async (gpt = false) => {
        await page.goto("https://completion.test");
        if (gpt) await page.getByRole("button", { name: "GPT", exact: true }).click();
        await expect(page.locator('[data-message="A-answer"]')).toBeAttached();
      };
      const scroller = page.getByTestId("scroller"),
        position = () => scroller.evaluate((el) => el.scrollTop),
        top = () =>
          scroller.evaluate(
            (el) =>
              el.querySelector("[data-message]")?.getBoundingClientRect().top -
              el.getBoundingClientRect().top,
          );
      for (const gpt of [false, true]) {
        await open(gpt);
        await expect.poll(top).toBeLessThan(0);
        await page.getByRole("button", { name: "Complete", exact: true }).click();
        await expect.poll(top).toBeGreaterThanOrEqual(8);
        assert((await top()) <= 10);
        await page.getByRole("button", { name: "Layout change" }).click();
        await expect.poll(top).toBeLessThanOrEqual(10);
        await expect(page.getByRole("textbox", { name: "Draft" })).toHaveValue("Keep draft");
        await open(gpt);
        await scroller.dispatchEvent("wheel", { deltaY: -400 });
        await scroller.evaluate((el) => (el.scrollTop = 100));
        await expect.poll(position).toBe(100);
        await page.getByRole("button", { name: "Complete", exact: true }).click();
        assert.equal(await position(), 100);
        await open(gpt);
        await page.getByRole("button", { name: "Short", exact: true }).click();
        const before = await position();
        await page.getByRole("button", { name: "Complete", exact: true }).click();
        assert.equal(await position(), before);
        await open(gpt);
        await page.getByRole("button", { name: "Other chat" }).click();
        const other = await position();
        await page.getByRole("button", { name: "Complete", exact: true }).click();
        assert.equal(await position(), other);
        assert((await top()) < 0);
        await open(gpt);
        await page.getByRole("button", { name: "Delayed row" }).click();
        await page.getByRole("button", { name: "Complete", exact: true }).click();
        await page.getByRole("button", { name: "Other chat" }).click();
        await page.getByRole("button", { name: "Delayed row" }).click();
        assert(Math.abs((await top()) - 9) > 5);
        await open(gpt);
        await page.getByRole("button", { name: "Toggle view" }).click();
        await page.getByRole("button", { name: "Complete", exact: true }).click();
        await page.getByRole("button", { name: "Toggle view" }).click();
        assert((await top()) < 0);
        await open(gpt);
        await page.evaluate(() => {
          Object.defineProperty(document, "hidden", { configurable: true, value: true });
          document.dispatchEvent(new Event("visibilitychange"));
        });
        await page.getByRole("button", { name: "Complete", exact: true }).click();
        await page.evaluate(() => {
          Object.defineProperty(document, "hidden", { configurable: true, value: false });
          document.dispatchEvent(new Event("visibilitychange"));
        });
        await page.getByRole("button", { name: "Layout change" }).click();
        assert((await top()) < 0);
      }
      assert.deepEqual(errors, []);
      console.log(
        engine +
          ": final response positioning, manual opt-out, short answers, layout changes, hidden views and stale conversation completions passed",
      );
    } finally {
      await browser.close();
    }
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}
