import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, expect, webkit } from "@playwright/test";
import { handoffFixture } from "./handoff-fixture.mjs";

await mkdir(".local/qa-turn-handoff", { recursive: true });
for (const [name, browserType] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
  const origin = "http://127.0.0.1:18842";
  const f = await handoffFixture(origin),
    browser = await browserType.launch();
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    serviceWorkers: "block",
  });
  try {
    await f.app.listen({ port: 18842, host: "127.0.0.1" });
    const [cookieName, cookieValue] = f.headers.cookie.split("=");
    await context.addCookies([
      {
        name: cookieName,
        value: cookieValue,
        url: origin,
        secure: false,
        httpOnly: true,
        sameSite: "Strict",
      },
    ]);
    await context.addInitScript(
      ({ threadId }) => {
        localStorage.setItem("codex-project", "project");
        localStorage.setItem("codex-thread", threadId);
        localStorage.setItem("codex-theme", "crt-green");
      },
      { threadId: f.thread.id },
    );
    const page = await context.newPage(),
      attempts = [],
      failures = [];
    page.on("pageerror", (e) => failures.push(e.message));
    page.on("request", (req) => {
      if (new URL(req.url()).pathname.endsWith("/turns") && req.method() === "POST")
        attempts.push({ key: req.headers()["idempotency-key"], body: req.postDataJSON() });
    });
    await page.goto(origin);
    const editor = page.getByRole("textbox", { name: "Сообщение Codex" }),
      send = page.getByRole("button", { name: "Отправить сообщение", exact: true });
    await expect(editor).toBeVisible();
    await expect(page.locator('input[type="file"]')).toBeEnabled();
    await page.locator('input[type="file"]').setInputFiles({
      name: "preserved.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Preserve this attachment"),
    });
    await expect(page.locator(".attachment-list")).toContainText("preserved.txt");
    await editor.fill("Продолжить в вебе с файлом");
    await expect(send).toBeEnabled();
    await send.tap();
    const dialog = page.getByRole("dialog", { name: "Продолжить на сайте?" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Отмена", exact: true }).tap();
    await expect(editor).toHaveValue("Продолжить в вебе с файлом");
    await expect(page.locator(".attachment-list")).toContainText("preserved.txt");
    assert.equal(f.desktopCalls.filter((a) => a === "ForceRelease").length, 0);
    assert.equal(f.calls.filter((c) => c.method === "turn/start").length, 0);
    await send.tap();
    await expect(dialog).toBeVisible();
    await page.screenshot({ path: `.local/qa-turn-handoff/${name}-confirm.png` });
    await dialog.getByRole("button", { name: "Продолжить и отправить", exact: true }).tap();
    await expect(editor).toHaveValue("", { timeout: 10000 });
    await expect(page.locator(".send-error")).toHaveCount(0);
    assert.equal(attempts.length, 3);
    assert.deepEqual(attempts[0], attempts[1]);
    assert.deepEqual(attempts[1], attempts[2]);
    assert.equal(f.calls.filter((c) => c.method === "turn/start").length, 1);
    assert.equal(f.desktopCalls.filter((a) => a === "ForceRelease").length, 1);
    assert.equal(
      f.desktopCalls.some((a) => a.includes("Restart")),
      false,
    );
    assert.deepEqual(failures, []);
    await page.screenshot({ path: `.local/qa-turn-handoff/${name}-sent.png` });
    console.log(
      `${name}: real Hub handoff, cancelled draft/file preserved, same key, one native send, no restart`,
    );
  } finally {
    await context.close();
    await browser.close();
    await f.close();
  }
}
