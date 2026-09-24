import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, expect, webkit } from "@playwright/test";
import react from "../apps/web/node_modules/@vitejs/plugin-react/dist/index.js";
import { build } from "../apps/web/node_modules/vite/dist/node/index.js";

const dir = await mkdtemp(join(tmpdir(), "textarea-"));
const screenshots = resolve(".cache/auto-textarea");
await mkdir(screenshots, { recursive: true });
try {
  await build({
    configFile: false,
    root: resolve("apps/web"),
    plugins: [react()],
    logLevel: "error",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: {
      outDir: dir,
      emptyOutDir: true,
      lib: {
        entry: resolve("apps/web/tests/fixtures/auto-textarea.tsx"),
        name: "Fixture",
        formats: ["iife"],
        fileName: () => "fixture.js",
      },
    },
  });
  const js = await readFile(join(dir, "fixture.js"), "utf8");
  const css = (
    await Promise.all(
      (
        await readdir(dir)
      )
        .filter((x) => x.endsWith(".css"))
        .map((x) => readFile(join(dir, x), "utf8")),
    )
  ).join("\n");
  for (const [name, type] of [
    ["chromium", chromium],
    ["webkit", webkit],
  ]) {
    const browser = await type.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      const errors = [];
      page.on("pageerror", (e) => {
        errors.push(e.message);
        console.error(e.message);
      });
      await page.route("https://fixture.test/**", (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === "/fixture.js")
          return route.fulfill({ contentType: "application/javascript", body: js });
        if (path === "/fixture.css") return route.fulfill({ contentType: "text/css", body: css });
        if (path !== "/") return route.abort();
        return route.fulfill({
          contentType: "text/html",
          body: '<!doctype html><html data-theme="organizer"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><body><div id="root"></div><script src="/fixture.js"></script></body></html>',
        });
      });
      await page.goto("https://fixture.test/");
      const field = page.getByRole("textbox", { name: "Сообщение Codex" });
      const size = () =>
        field.evaluate((el) => ({
          h: el.getBoundingClientRect().height,
          line: parseFloat(getComputedStyle(el).lineHeight),
          overflow: getComputedStyle(el).overflowY,
          content: el.scrollHeight,
          client: el.clientHeight,
        }));
      for (const theme of ["organizer", "crt-green", "hitech-2000s", "classic-dark"]) {
        await page.evaluate((t) => window.setTheme(t), theme);
        await field.fill("строка\n".repeat(3) + "строка");
        await expect.poll(async () => (await size()).overflow).toBe("hidden");
        const base = await size();
        for (let lines = 5; lines <= 10; lines++) {
          await field.fill(Array(lines).fill("строка").join("\n"));
          await expect
            .poll(async () => (await size()).h)
            .toBeCloseTo(base.h + (Math.min(lines, 8) - 4) * base.line, 0);
          assert.equal((await size()).overflow, lines > 8 ? "auto" : "hidden");
        }
        await page.evaluate(() => {
          const el = document.querySelector('[data-testid="scroll"]');
          el.scrollTop = 100;
          window.setText("маленький черновик");
        });
        await expect.poll(async () => (await size()).h).toBeCloseTo(base.h, 0);
        assert.equal(await page.getByTestId("scroll").evaluate((el) => el.scrollTop), 100);
        await field.fill("перенос слов ".repeat(55));
        await expect.poll(async () => (await size()).overflow).toBe("auto");
        await page.evaluate(() => window.setHidden(true));
        await page.evaluate(() =>
          window.setText(Array(6).fill("Восстановленный черновик").join("\n")),
        );
        await page.evaluate(() => window.setHidden(false));
        await expect(field).toBeVisible();
        await expect.poll(async () => (await size()).h).toBeGreaterThan(base.h);
        for (const [label, width, height] of [
          ["phone", 390, 844],
          ["keyboard", 390, 480],
          ["tablet", 1024, 768],
          ["wide", 1366, 1024],
        ]) {
          await page.setViewportSize({ width, height });
          await field.fill(Array(6).fill("Строка сообщения").join("\n"));
          await page.screenshot({ path: join(screenshots, `${name}-${theme}-${label}.png`) });
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        }
        await page.setViewportSize({ width: 390, height: 844 });
      }
      const uncontrolled = page.getByRole("textbox", { name: "Сообщение GPT" });
      await uncontrolled.fill(Array(9).fill("строка").join("\n"));
      assert.equal(await uncontrolled.evaluate((el) => getComputedStyle(el).overflowY), "auto");
      await uncontrolled.fill("коротко");
      assert.equal(await uncontrolled.evaluate((el) => getComputedStyle(el).overflowY), "hidden");
      assert.deepEqual(errors, []);
      console.log(
        `${name}: four-to-eight lines, wrapping, drafts, hidden fields, scroll preservation and four themes passed`,
      );
    } finally {
      await browser.close();
    }
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}
