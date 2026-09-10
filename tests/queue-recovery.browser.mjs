import assert from "node:assert/strict";
import { chromium, expect, webkit } from "@playwright/test";
import { handoffFixture } from "./handoff-fixture.mjs";

for (const [name, type] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
  const origin = "http://127.0.0.1:18846",
    f = await handoffFixture(origin),
    browser = await type.launch();
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    serviceWorkers: "block",
  });
  try {
    await f.app.listen({ port: 18846, host: "127.0.0.1" });
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
    const page = await context.newPage();
    let failing = true,
      reads = 0,
      writes = 0;
    await page.route("**/api/threads/*/queue", async (route) => {
      if (route.request().method() === "GET") {
        reads++;
        return failing
          ? route.fulfill({ status: 502, contentType: "text/html", body: "<h1>Bad Gateway</h1>" })
          : route.fulfill({ json: { available: true, canSteer: true, items: [] } });
      }
      writes++;
      return route.fulfill({ status: 502, contentType: "text/html", body: "<h1>Bad Gateway</h1>" });
    });
    await page.goto(origin);
    const queue = page.locator(".message-queue"),
      editor = page.getByRole("textbox", { name: "Сообщение Codex" });
    await expect(editor).toBeVisible();
    await editor.fill("Keep draft through queue polling failures");
    await expect.poll(() => reads).toBeGreaterThanOrEqual(1);
    await expect(queue).toHaveCount(0);
    await expect.poll(() => reads, { timeout: 10000 }).toBeGreaterThanOrEqual(3);
    await expect(queue).toContainText("Не удалось обновить очередь");
    await expect(queue.locator(".queue-heading")).toHaveCount(0);
    await expect(queue).not.toContainText("Черновик");
    failing = false;
    await expect(queue).toHaveCount(0, { timeout: 10000 });
    await expect(editor).toHaveValue("Keep draft through queue polling failures");
    assert.equal(writes, 0);
    assert.equal(f.calls.filter((c) => c.method === "turn/start").length, 0);

    await page.getByRole("button", { name: "Отправить сообщение", exact: true }).click();
    await expect(editor).toHaveValue("");
    await editor.fill("Keep unconfirmed queued draft");
    await page.getByRole("button", { name: "Добавить в очередь", exact: true }).click();
    await expect(queue).toContainText("Сервер не подтвердил действие");
    await expect(queue.locator(".queue-heading")).toHaveCount(0);
    await expect(editor).toHaveValue("Keep unconfirmed queued draft");
    const afterWrite = reads;
    await expect.poll(() => reads, { timeout: 10000 }).toBeGreaterThan(afterWrite + 1);
    await expect(queue).toContainText("Сервер не подтвердил действие");
    await expect(editor).toHaveValue("Keep unconfirmed queued draft");
    assert.equal(writes, 1, "successful polling must not replay an uncertain mutation");
    assert.equal(f.calls.filter((c) => c.method === "turn/start").length, 1);
    await page.screenshot({ path: `/tmp/queue-recovery-${name}.png` });
    f.finishTurn();
    console.log(
      name +
        ": queue read outages recover, draft remains, unknown writes stay visible without replay or empty queue heading",
    );
  } finally {
    await context.close();
    await browser.close();
    await f.close();
  }
}
