import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, expect, webkit } from "@playwright/test";
import react from "../apps/web/node_modules/@vitejs/plugin-react/dist/index.js";
import { build } from "../apps/web/node_modules/vite/dist/node/index.js";

const dir = await mkdtemp(join(tmpdir(), "pinned-navigation-"));
const items = Array.from({ length: 6 }, (_, i) => ({
  id: "pin" + i,
  title: "Закреплённый " + i,
  pinned: true,
  updatedAt: 10 + i,
}));
items.push({ id: "live", title: "Активный без закрепления", pinned: false, updatedAt: 50 });
const server = createServer(async (req, res) => {
  const path = new URL(req.url, "http://fixture").pathname;
  const json = (data) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(data));
  };
  if (path === "/") {
    res.setHeader("Content-Type", "text/html");
    return res.end(
      '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script>',
    );
  }
  if (path === "/icon.svg") {
    res.setHeader("Content-Type", "image/svg+xml");
    return res.end(await readFile(resolve("apps/web/public/icon.svg")));
  }
  if (path === "/fixture.js") {
    res.setHeader("Content-Type", "text/javascript");
    return res.end(await readFile(join(dir, "fixture.js")));
  }
  if (path === "/fixture.css") {
    res.setHeader("Content-Type", "text/css");
    return res.end(
      (
        await Promise.all(
          (
            await readdir(dir)
          )
            .filter((f) => f.endsWith(".css"))
            .map((f) => readFile(join(dir, f), "utf8")),
        )
      ).join("\n"),
    );
  }
  if (/^\/fonts\/[a-zA-Z0-9._-]+\.woff2$/.test(path)) {
    res.setHeader("Content-Type", "font/woff2");
    return res.end(await readFile(resolve("apps/web/public" + path)));
  }
  if (path === "/api/gpt/status")
    return json({ configured: true, canSend: true, state: "healthy" });
  if (path === "/api/gpt/models") return json({ models: [], efforts: [] });
  if (path === "/api/gpt/conversations") return json({ items, nextOffset: null });
  if (path === "/api/gpt/jobs")
    return json({
      items: [
        {
          id: "job",
          nativeId: "live",
          status: "running",
          text: "Working",
          files: [],
          assets: [],
          updatedAt: 50,
        },
      ],
      stamp: 1,
    });
  if (path.endsWith("/messages"))
    return json({ items: [], nextBefore: null, revision: "1", prefix: "1" });
  return json({ items: [], conversations: [], nextOffset: null });
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
        entry: resolve("apps/web/tests/fixtures/pinned-navigation.tsx"),
        name: "PinnedFixture",
        formats: ["iife"],
        fileName: () => "fixture.js",
      },
    },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = "http://127.0.0.1:" + server.address().port;
  await mkdir(".local/qa-pinned", { recursive: true });
  for (const [engine, type] of [
    ["chromium", chromium],
    ["webkit", webkit],
  ]) {
    const browser = await type.launch();
    try {
      for (const mode of ["gpt", "codex"]) {
        const context = await browser.newContext({
          viewport: { width: 390, height: 844 },
          hasTouch: true,
        });
        const page = await context.newPage();
        await page.goto(origin + "/?" + mode);
        const show = async () => {
          if (mode === "gpt")
            await page.getByRole("button", { name: "Открыть проекты", exact: true }).tap();
          else await page.getByRole("button", { name: /^Диалоги/ }).tap();
        };
        await show();
        const panel = page.locator(".pinned-panel:visible");
        await expect(panel.locator(".entity-row")).toHaveCount(3);
        assert.deepEqual(
          await panel
            .locator(".nav-thread > span")
            .allTextContents()
            .then((values) => values.filter(Boolean)),
          ["Закреплённый 5", "Закреплённый 4", "Закреплённый 3"],
        );
        const live = page
          .getByRole("button", { name: /^Активный без закрепления/ })
          .filter({ visible: true });
        await expect(live).toBeVisible();
        assert((await live.boundingBox()).y < (await panel.boundingBox()).y);
        await panel.getByRole("button", { name: "Показать все закреплённые" }).tap();
        await expect(panel.locator(".entity-row")).toHaveCount(6);
        await page.reload();
        await show();
        await expect(panel.locator(".entity-row")).toHaveCount(6);
        await panel.getByRole("button", { name: "Свернуть закреплённые" }).tap();
        await expect(panel.locator(".entity-row")).toHaveCount(3);
        const search = page
          .getByRole("textbox", {
            name: mode === "gpt" ? "Найти чат GPT" : "Поиск проектов и диалогов",
          })
          .or(page.getByRole("searchbox", { name: "Поиск проектов и диалогов" }))
          .filter({ visible: true });
        await search.fill("Закреплённый 0");
        await expect(panel.locator(".entity-row")).toHaveCount(1);
        await expect(panel).toContainText("Закреплённый 0");
        await search.fill("");
        await expect(panel.locator(".entity-row")).toHaveCount(3);
        const toggle = panel.getByRole("button", { name: "Показать все закреплённые" });
        assert((await toggle.boundingBox()).height >= 44);
        for (const theme of ["crt-green", "organizer", "hitech-2000s", "classic-dark"]) {
          await page.evaluate((theme) => {
            document.documentElement.dataset.theme = theme;
          }, theme);
          await page.screenshot({ path: `.local/qa-pinned/${engine}-${mode}-${theme}.png` });
          assert.equal(await panel.evaluate((el) => getComputedStyle(el).borderTopStyle), "solid");
        }
        // Row actions stay reachable without expanding the rest of the pins.
        await panel.locator(".entity-row").first().locator("button").last().tap();
        await expect(
          page.getByRole("dialog", { name: "Закреплённый 5", exact: true }),
        ).toBeVisible();
        await page.keyboard.press("Escape");
        await context.close();
        console.log(
          engine +
            " " +
            mode +
            ": three recent pins, expand/persist/search, live priority, actions, themes OK",
        );
      }
    } finally {
      await browser.close();
    }
  }
} finally {
  server.close();
  server.closeAllConnections();
  await rm(dir, { recursive: true, force: true });
}
