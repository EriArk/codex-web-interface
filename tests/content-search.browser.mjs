import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, expect, webkit } from "@playwright/test";
import { handoffFixture } from "./handoff-fixture.mjs";

for (const [engine, type] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
  const origin = "http://127.0.0.1:18928",
    f = await handoffFixture(origin),
    browser = await type.launch(),
    context = await browser.newContext({
      viewport: { width: 393, height: 852 },
      hasTouch: true,
      serviceWorkers: "block",
    });
  try {
    f.store.setPreferences({ projectId: "project", threadId: f.thread.id });
    f.store.db
      .prepare("INSERT INTO workspace_notes VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(
        "search-note",
        "global",
        null,
        "Важная заметка",
        "Настройка сервера и КИРИЛЛИЦА",
        "настройка сервера и кириллица",
        "[]",
        1,
        Date.now(),
        Date.now(),
      );
    await f.app.listen({ port: 18928, host: "127.0.0.1" });
    const [name, value] = f.headers.cookie.split("=");
    await context.addCookies([{ name, value, url: origin, httpOnly: true }]);
    const page = await context.newPage(),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(origin);
    await page.getByRole("button", { name: "Открыть проекты", exact: true }).click();
    await page.getByRole("button", { name: "Поиск по содержимому", exact: true }).click();
    const modal = page.getByRole("dialog", { name: "Поиск по содержимому" });
    await modal.getByRole("combobox", { name: "Где искать" }).selectOption("all");
    await modal.getByRole("searchbox", { name: "Искать в тексте" }).fill("кириллица");
    await modal.getByRole("button", { name: "Найти", exact: true }).click();
    await expect(modal.getByRole("button", { name: /Важная заметка/ })).toBeVisible();
    await mkdir(`.local/qa-content-search/${engine}`, { recursive: true });
    for (const theme of ["classic-dark", "organizer", "crt-green", "hitech-2000s"]) {
      await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
      for (const width of [320, 393, 1366]) {
        await page.setViewportSize({ width, height: width < 1000 ? 852 : 1024 });
        const rect = await modal.boundingBox();
        assert(rect.x >= 0 && rect.x + rect.width <= width + 1);
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await page.screenshot({ path: `.local/qa-content-search/${engine}/${theme}-${width}.png` });
      }
    }
    await modal.getByRole("button", { name: /Важная заметка/ }).click();
    await expect(modal).not.toBeVisible();
    await expect(page.getByText("Важная заметка", { exact: true }).first()).toBeVisible();
    assert(!f.calls.some((c) => c.method === "turn/start"));
    assert.deepEqual(errors, []);
    console.log(engine + ": content search navigation and four-theme phone/tablet layout passed");
  } finally {
    await context.close();
    await browser.close();
    await f.close();
  }
}
