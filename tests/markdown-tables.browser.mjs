import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, expect, webkit } from "@playwright/test";
import react from "../apps/web/node_modules/@vitejs/plugin-react/dist/index.js";
import { build } from "../apps/web/node_modules/vite/dist/node/index.js";

const dir = await mkdtemp(join(tmpdir(), "codex-tables-"));
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
        entry: resolve("apps/web/tests/fixtures/markdown-tables.tsx"),
        name: "TablesFixture",
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
        .filter((f) => f.endsWith(".css"))
        .map((f) => readFile(join(dir, f), "utf8")),
    )
  ).join("\n");
  await mkdir(".local/qa-tables", { recursive: true });
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
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.route("https://tables.test/**", async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === "/fixture.js")
          return route.fulfill({ contentType: "application/javascript", body: js });
        if (path === "/fixture.css") return route.fulfill({ contentType: "text/css", body: css });
        if (/^\/fonts\/[a-zA-Z0-9._-]+\.woff2$/.test(path))
          return route.fulfill({
            contentType: "font/woff2",
            body: await readFile(resolve(`apps/web/public${path}`)),
          });
        if (path !== "/") return route.fulfill({ status: 404, body: "" });
        return route.fulfill({
          contentType: "text/html",
          body: '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script>',
        });
      });
      await page.goto("https://tables.test/");
      for (const theme of ["organizer", "crt-green", "hitech-2000s", "classic-dark"]) {
        await page.evaluate((theme) => {
          document.documentElement.dataset.theme = theme;
        }, theme);
        await page.evaluate(() => document.fonts.ready);
        for (const width of [320, 390, 844, 1366]) {
          await page.setViewportSize({ width, height: width >= 844 ? 1024 : 844 });
          // A tablet's chat can remain narrow between the independent side panes.
          await page.locator("main").evaluate((el, width) => {
            el.style.maxWidth = width === 1366 ? "440px" : "720px";
          }, width);
          const metrics = await page.evaluate(() => {
            const broken = [];
            const sizes = [];
            for (const article of document.querySelectorAll(
              '[data-example="sections"], [data-example="features"]',
            )) {
              for (const cell of article.querySelectorAll("tr > :first-child")) {
                const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
                while (walker.nextNode()) {
                  const node = walker.currentNode;
                  for (const match of node.textContent.matchAll(/[\p{L}]+/gu)) {
                    const range = document.createRange();
                    range.setStart(node, match.index);
                    range.setEnd(node, match.index + match[0].length);
                    if (range.getClientRects().length > 1) broken.push(match[0]);
                  }
                }
              }
              const wrap = article.querySelector(".markdown-table-scroll");
              sizes.push({ width: wrap.clientWidth, scroll: wrap.scrollWidth });
            }
            return {
              broken,
              sizes,
              pageWidth: document.documentElement.scrollWidth,
              viewport: innerWidth,
            };
          });
          assert.deepEqual(
            metrics.broken,
            [],
            `${name}/${theme}/${width}: words split in the label column`,
          );
          assert(
            metrics.pageWidth <= metrics.viewport,
            `${name}/${theme}/${width}: table widened the page`,
          );
          for (const size of width >= 390 ? metrics.sizes : [])
            assert(
              size.scroll <= size.width + 1,
              `${name}/${theme}/${width}: ordinary two-column table should fit`,
            );
          const wide = page.locator(
            '[data-client="gpt"] [data-example="wide"] .markdown-table-scroll',
          );
          if (width <= 390 || width === 1366) {
            await expect(wide).toHaveAttribute("tabindex", "0");
            await expect(wide).toHaveAttribute("role", "region");
            assert(await wide.evaluate((el) => el.scrollWidth > el.clientWidth));
            await wide.focus();
            await page.keyboard.press("ArrowRight");
            await expect.poll(() => wide.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
            await wide.evaluate((el) => {
              el.scrollLeft = 0;
            });
          }
          for (const wrap of await page
            .locator('[data-example="tokens"] .markdown-table-scroll')
            .all()) {
            assert(
              await wrap.evaluate((el) => el.scrollWidth < 1400),
              "A long token must not create thousands of pixels of horizontal travel",
            );
          }
          await expect(
            page.locator('[data-client="gpt"] [data-example="tokens"] a').first(),
          ).toHaveAttribute("href", "https://example.test/docs");
          const alignments = await wide
            .locator("th")
            .evaluateAll((cells) =>
              cells.slice(0, 3).map((cell) => getComputedStyle(cell).textAlign),
            );
          assert.deepEqual(
            alignments,
            ["left", "center", "right"],
            "Keep Markdown column alignment",
          );
          if (name === "webkit" && [390, 1366].includes(width)) {
            await page
              .locator('[data-client="gpt"] [data-example="features"]')
              .screenshot({ path: `.local/qa-tables/${theme}-${width}.png` });
          }
        }
      }
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByRole("button", { name: "Продолжить ответ" }).focus();
      const selected = page.locator(
        '[data-client="gpt"] [data-example="wide"] .markdown-table-scroll',
      );
      await selected.evaluate((el) => {
        el.scrollLeft = 80;
      });
      const previousScroll = await selected.evaluate((el) => el.scrollLeft);
      await page.getByRole("button", { name: "Продолжить ответ" }).click();
      await expect(page.locator('[data-client="gpt"] [data-example="features"]')).toContainText(
        "Текст продолжения ответа.",
      );
      assert.equal(
        await selected.evaluate((el) => el.scrollLeft),
        previousScroll,
        "Streaming keeps table scroll position",
      );
      await expect(page.getByRole("textbox", { name: "Черновик" })).toHaveValue("Мой черновик");
      // Exercise the actual project swipe hook with a left-edge table gesture, then a normal gesture.
      for (const [selector, expected] of [
        [".markdown-table-scroll td", "0"],
        ['[data-testid="edge"]', "1"],
      ]) {
        await page
          .locator(selector)
          .first()
          .evaluate((el) => {
            const x = document.querySelector("main").getBoundingClientRect().left + 15;
            const y = el.getBoundingClientRect().top + 8;
            const emit = (type, dx, ended) => {
              const point = { identifier: 1, target: el, clientX: x + dx, clientY: y };
              const event = new Event(type, { bubbles: true, cancelable: true });
              Object.defineProperties(event, {
                touches: { value: ended ? [] : [point] },
                changedTouches: { value: [point] },
              });
              el.dispatchEvent(event);
            };
            emit("touchstart", 0, false);
            emit("touchmove", 100, false);
            emit("touchend", 100, true);
          });
        await expect(page.getByTestId("opens")).toHaveText(expected);
      }
      await page.setViewportSize({ width: 1366, height: 1024 });
      await page.locator("main").evaluate((el) => {
        el.style.maxWidth = "1200px";
      });
      await expect(selected).not.toHaveAttribute("tabindex");
      await expect(selected).not.toHaveAttribute("role");
      assert.deepEqual(errors, []);
      console.log(
        JSON.stringify({
          browser: name,
          themes: 4,
          widths: [320, 390, 844, 1366],
          clients: ["codex", "gpt", "readme"],
          wordsIntact: true,
          boundedScroll: true,
          keyboard: true,
          alignment: true,
          streamAndDraftPreserved: true,
          swipe: true,
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
