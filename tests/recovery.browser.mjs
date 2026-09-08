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
    const recover = page.getByRole("button", { name: "Восстановить диалог", exact: true });
    await expect(editor).toBeVisible();
    await editor.fill("Черновик остаётся до моей отправки");
    await expect(recover).toBeEnabled();
    await recover.tap();
    await expect(page.getByText("Восстанавливаем связь…", { exact: true })).toBeVisible();
    const pending = page.getByRole("button", { name: "Подключаемся…", exact: true });
    await expect(pending).toBeDisabled();
    await expect.poll(() => attempts).toBe(1);
    await page.screenshot({ path: `.local/qa-recovery/${engine}-pending.png` });
    release();
    await expect(page.locator(".connection-recovery")).toContainText("Компьютер недоступен");
    await expect(recover).toBeEnabled();
    await expect(editor).toHaveValue("Черновик остаётся до моей отправки");
    failed = false;
    await recover.tap();
    await expect.poll(() => attempts).toBe(2);
    release();
    await expect(
      page.getByText("Связь восстановлена. Codex продолжает работу.", { exact: true }),
    ).toBeVisible();
    await expect(editor).toHaveValue("Черновик остаётся до моей отправки");
    await expect(recover).toHaveCount(0);
    await page.screenshot({ path: `.local/qa-recovery/${engine}-running.png` });
    await page.getByRole("button", { name: "Скрыть результат восстановления" }).tap();
    await expect(page.locator(".connection-recovery")).toHaveCount(0);
    f.store.setStatus(f.thread.id, "unknown", "last-turn");
    await page.reload();
    status = "idle";
    await expect(recover).toBeEnabled();
    await recover.tap();
    await expect.poll(() => attempts).toBe(3);
    release();
    await expect(
      page.getByText("Диалог восстановлен. Чтобы продолжить задачу, отправь сообщение.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(editor).toHaveValue("Черновик остаётся до моей отправки");
    await page.screenshot({ path: `.local/qa-recovery/${engine}-idle.png` });
    assert.equal(f.calls.filter((c) => c.method === "turn/start").length, 0);
    assert.equal(f.desktopCalls.filter((c) => c.includes("Restart")).length, 0);
    console.log(
      engine +
        ": recovery pending, failure/retry, active/idle feedback, draft preserved, no replay/restart",
    );
  } finally {
    await context.close();
    await browser.close();
    await f.close();
  }
}
