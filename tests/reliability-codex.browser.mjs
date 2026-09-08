import assert from "node:assert/strict";
import { chromium, expect, webkit } from "@playwright/test";
import { handoffFixture } from "./handoff-fixture.mjs";

for (const [name, type] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
  const origin = "http://127.0.0.1:18843",
    f = await handoffFixture(origin),
    browser = await type.launch();
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    serviceWorkers: "block",
  });
  try {
    await f.app.listen({ port: 18843, host: "127.0.0.1" });
    assert.equal((await f.release()).statusCode, 200);
    const [cookieName, value] = f.headers.cookie.split("=");
    await context.addCookies([
      { name: cookieName, value, url: origin, secure: false, httpOnly: true, sameSite: "Strict" },
    ]);
    await context.addInitScript(
      ({ threadId }) => {
        localStorage.setItem("codex-project", "project");
        localStorage.setItem("codex-thread", threadId);
      },
      { threadId: f.thread.id },
    );
    const page = await context.newPage(),
      attempts = [];
    await page.route("**/api/threads/*/turns", async (route) => {
      attempts.push({
        key: route.request().headers()["idempotency-key"],
        body: route.request().postDataJSON(),
      });
      const reply = await route.fetch();
      assert.equal(reply.status(), 200);
      if (attempts.length === 1 || attempts.length === 3) return route.abort("connectionreset");
      return route.fulfill({ response: reply });
    });
    await page.goto(origin);
    const editor = page.getByRole("textbox", { name: "Сообщение Codex" }),
      send = page.getByRole("button", { name: "Отправить сообщение", exact: true });
    await expect(editor).toBeVisible();
    await editor.fill("Retain this draft after a lost HTTP acknowledgement");
    await send.click();
    await expect.poll(() => f.calls.filter((c) => c.method === "turn/start").length).toBe(1);
    await expect(page.locator(".send-error")).toBeVisible();
    await page.reload();
    await expect(editor).toHaveValue("Retain this draft after a lost HTTP acknowledgement");
    await expect(send).toBeEnabled();
    await send.click();
    await expect(editor).toHaveValue("");
    assert.equal(attempts.length, 2);
    assert.deepEqual(attempts[0], attempts[1]);
    assert.equal(f.calls.filter((c) => c.method === "turn/start").length, 1);
    assert.equal(f.calls.filter((c) => c.method === "thread/queue/add").length, 0);
    f.finishTurn();
    await expect(page.getByRole("button", { name: "Остановить Codex", exact: true })).toHaveCount(
      0,
    );
    await editor.fill("Retain this draft after a lost HTTP acknowledgement");
    await send.click();
    await expect.poll(() => f.calls.filter((c) => c.method === "turn/start").length).toBe(2);
    f.finishTurn();
    await expect(page.locator(".send-error")).toBeVisible();
    await page.reload();
    await expect(editor).toHaveValue("Retain this draft after a lost HTTP acknowledgement");
    await send.click();
    await expect(editor).toHaveValue("");
    assert.equal(attempts.length, 4);
    assert.deepEqual(attempts[2], attempts[3]);
    assert.notEqual(attempts[0].key, attempts[2].key);
    assert.equal(f.calls.filter((c) => c.method === "turn/start").length, 2);

    console.log(
      name +
        ": real Hub accepts once across lost HTTP acknowledgement, completed turn, reload and explicit retry",
    );
  } finally {
    await context.close();
    await browser.close();
    await f.close();
  }
}
