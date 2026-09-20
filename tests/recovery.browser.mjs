import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, expect, webkit } from "@playwright/test";
import { handoffFixture } from "./handoff-fixture.mjs";

await mkdir(".local/qa-recovery", { recursive: true });
for (const [engine, type] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
  const origin = "http://127.0.0.1:18849",
    f = await handoffFixture(origin);
  const browser = await type.launch();
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    serviceWorkers: "block",
  });
  try {
    await f.release();
    f.store.setStatus(f.thread.id, "unknown", "last-turn");
    f.store.setPreferences({ projectId: "project", threadId: f.thread.id });
    await f.app.listen({ port: 18849, host: "127.0.0.1" });
    const [name, value] = f.headers.cookie.split("=");
    await context.addCookies([{ name, value, url: origin, httpOnly: true, sameSite: "Strict" }]);
    const page = await context.newPage();
    let release,
      attempts = 0,
      status = "running",
      failed = true;
    await page.route("**/api/threads/*/resume", async (route) => {
      attempts++;
      await new Promise((resolve) => {
        release = resolve;
      });
      if (failed)
        return route.fulfill({
          status: 503,
          json: { error: { code: "TRANSPORT_UNAVAILABLE", message: "Компьютер недоступен" } },
        });
      f.store.setStatus(f.thread.id, status, status === "running" ? "last-turn" : null);
      await route.fulfill({ json: f.store.thread(f.thread.id) });
    });
    await page.goto(origin);
    const editor = page.getByRole("textbox", { name: "Сообщение Codex" });
    const recover = page.getByRole("button", { name: "Повторить подключение", exact: true });
    await expect(editor).toBeVisible();
    await editor.fill("Черновик остаётся до моей отправки");
    await expect.poll(() => attempts).toBe(1);
    await expect(page.locator(".connection-recovery")).toHaveCount(0);
    release();
    await expect(page.locator(".connection-recovery")).toContainText("Компьютер недоступен");
    await expect(recover).toBeEnabled();
    await expect(editor).toHaveValue("Черновик остаётся до моей отправки");
    failed = false;
    await recover.tap();
    await expect.poll(() => attempts).toBe(2);
    await expect(page.getByRole("button", { name: "Подключаемся…", exact: true })).toBeDisabled();
    release();
    await expect(page.locator(".connection-recovery")).toHaveCount(0);
    await expect(editor).toHaveValue("Черновик остаётся до моей отправки");
    f.store.setStatus(f.thread.id, "unknown", "last-turn");
    status = "idle";
    await page.reload();
    await expect.poll(() => attempts).toBe(3);
    await expect(page.locator(".connection-recovery")).toHaveCount(0);
    release();
    await expect(editor).toHaveValue("Черновик остаётся до моей отправки");
    await expect(page.locator(".connection-recovery")).toHaveCount(0);
    await page.screenshot({ path: `.local/qa-recovery/${engine}-idle.png` });
    assert.equal(f.calls.filter((c) => c.method === "turn/start").length, 0);
    assert.equal(f.desktopCalls.filter((c) => c.includes("Restart")).length, 0);
    console.log(
      engine +
        ": quiet automatic recovery, failure/manual retry, draft preserved, no replay/restart",
    );
  } finally {
    await context.close();
    await browser.close();
    await f.close();
  }
}
