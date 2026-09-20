import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, expect, webkit } from "@playwright/test";
import react from "../apps/web/node_modules/@vitejs/plugin-react/dist/index.js";
import { build } from "../apps/web/node_modules/vite/dist/node/index.js";

const dir = await mkdtemp(join(tmpdir(), "gpt-result-links-"));
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

  await mkdir(".local/qa-gpt-result-links", { recursive: true });
  for (const [name, type] of [
    ["chromium", chromium],
    ["webkit", webkit],
  ]) {
    const browser = await type.launch(),
      context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
    try {
      const page = await context.newPage();
      const links = Array.from({ length: 24 }, (_, i) => ({
        id: `link-${i}`,
        type: "link",
        title: i === 0 ? "Documentation with a very long title ".repeat(8) : `Documentation ${i}`,
        turnId: "reply",
        createdAt: new Date(0).toISOString(),
        payload: { url: `https://example.org/doc/${i}?a=1&b=2` },
      }));
      const demo = {
        id: "demo",
        type: "preview",
        title: "Interactive demo",
        turnId: "reply",
        createdAt: new Date(0).toISOString(),
        payload: {
          url: "/api/gpt/previews/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
      };
      const reasoning = {
        id: "reasoning-request",
        type: "reasoning",
        title: "Review the project",
        turnId: "request",
        createdAt: new Date(0).toISOString(),
        payload: {
          text: "Review the project",
          steps: [
            { id: "s1", text: "Просмотр материалов", activity: "review", state: "completed" },
            { id: "s2", text: "Public intermediate message", state: "completed" },
          ],
        },
      };
      const counts = { all: 26, links: 24, demos: 1, files: 0, images: 0, work: 0, reasoning: 1 };
      let initialReads = 0;
      await page.route("https://outbox.test/**", async (route) => {
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
        if (path.endsWith("/results")) {
          if (url.searchParams.get("category") === "files" && ++initialReads === 1)
            return route.fulfill({
              status: 503,
              json: {
                error: {
                  code: "GPT_HISTORY_UNAVAILABLE",
                  message: "Temporary native history failure",
                },
              },
            });
          const category = url.searchParams.get("category"),
            items =
              category === "links"
                ? links
                : category === "demos"
                  ? [demo]
                  : category === "all"
                    ? [demo, ...links]
                    : category === "reasoning"
                      ? [reasoning]
                      : [];
          const offset = url.searchParams.has("before") ? 20 : 0;
          return route.fulfill({
            json: {
              items: items.slice(offset, offset + 20),
              counts,
              nextBefore: items.length > offset + 20 ? items[offset + 19].id : null,
            },
          });
        }
        if (path.endsWith("/ready")) return route.fulfill({ json: { ready: true } });
        if (
          path ===
          "/api/gpt/previews/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        )
          return route.fulfill({
            contentType: "text/html",
            body: `<button onclick="this.textContent='Clicked'">Demo action</button>`,
          });
        return route.fulfill({ json: {} });
      });
      await page.addInitScript(() => {
        window.popups = [];
        window.open = (...args) => {
          window.popups.push(args);
          return null;
        };
      });
      await page.goto("https://outbox.test/");
      const filters = page.locator(".result-filters button");
      await expect.poll(() => initialReads).toBe(1);
      await expect(page.locator(".results-error")).toHaveCount(0);
      await expect(page.locator(".empty-state h2")).toHaveText("Загружаем…");
      await expect.poll(() => initialReads, { timeout: 8000 }).toBe(2);
      await expect(page.locator(".empty-state h2")).toHaveText("Пока нет результатов.");
      await expect(filters).toHaveText([
        /^Файлы/,
        /^Изображения/,
        /^Ссылки/,
        /^Демо/,
        /^Рассуждения/,
      ]);
      await expect(filters.first()).toHaveAttribute("aria-pressed", "true");
      await filters.nth(2).click();
      await expect(page.locator(".result-site-link")).toHaveCount(20);
      await page.locator(".load-more").click();
      await expect(page.locator(".result-site-link")).toHaveCount(24);
      const button = page.locator(".result-site-link").first();
      await button.click();
      const popup = await page.evaluate(() => window.popups[0]);
      assert.equal(popup[0], links[0].payload.url);
      assert.match(popup[2], /popup=yes/);
      assert.match(popup[2], /noopener,noreferrer/);
      assert.equal(page.url(), "https://outbox.test/");
      for (const theme of ["organizer", "crt-green", "hitech-2000s", "classic-dark"]) {
        await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
        const box = await button.boundingBox();
        assert(box.height >= 44 && box.height < 90);
        assert(box.width <= 390);
        await page.screenshot({ path: `.local/qa-gpt-result-links/${name}-${theme}.png` });
      }
      await expect(filters).toHaveCount(5);
      await filters.nth(4).click();
      await page.locator(".result-reasoning-details summary").click();
      await expect(page.locator(".gpt-public-steps")).toContainText("Public intermediate message");
      await expect(page.locator(".gpt-public-steps svg")).toHaveCount(2);
      await page.screenshot({ path: `.local/qa-gpt-result-links/${name}-reasoning.png` });
      await filters.nth(3).click();
      await page.locator(".result-demo-open").click();
      const frame = page.locator("iframe");
      await expect(frame).toHaveAttribute("sandbox", "allow-scripts");
      await page.frameLocator("iframe").getByRole("button", { name: "Demo action" }).click();
      await expect(
        page.frameLocator("iframe").getByRole("button", { name: "Clicked" }),
      ).toBeVisible();
      console.log(
        JSON.stringify({
          browser: name,
          links: 24,
          popup: true,
          themes: 4,
          demoInteractive: true,
          workHidden: true,
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
