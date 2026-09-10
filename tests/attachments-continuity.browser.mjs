import assert from "node:assert/strict";
import { chromium, expect, webkit } from "@playwright/test";
import { handoffFixture } from "./handoff-fixture.mjs";

for (const [engine, type] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
  const origin = "http://127.0.0.1:18863",
    f = await handoffFixture(origin);
  await f.release();
  f.store.setPreferences({
    projectId: "project",
    threadId: f.thread.id,
    theme: "classic-dark",
    view: "chat",
  });
  const browser = await type.launch(),
    context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      serviceWorkers: "block",
    });
  try {
    await f.app.listen({ port: 18863, host: "127.0.0.1" });
    const [name, value] = f.headers.cookie.split("=");
    await context.addCookies([{ name, value, url: origin, httpOnly: true, sameSite: "Strict" }]);
    const page = await context.newPage();
    let release,
      waiting = false;
    const gate = new Promise((r) => (release = r));
    await page.route("**/api/threads/*/attachments", async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      waiting = true;
      await gate;
      return route.fulfill({ json: { attachments: [] } });
    });
    await page.goto(origin);
    await expect(page.getByRole("textbox", { name: "Сообщение Codex" })).toBeVisible();
    await expect.poll(() => waiting).toBe(true);
    await page.getByLabel("Выбрать файлы или изображения", { exact: true }).setInputFiles({
      name: "audit-draft.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("attachment race fixture"),
    });
    const attachment = page.getByRole("button", { name: "Удалить audit-draft.txt", exact: true });
    await expect(attachment).toBeVisible();
    const done = page.waitForResponse(
      (r) => r.request().method() === "GET" && r.url().endsWith("/attachments"),
    );
    release();
    await done;
    await page.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    );
    await expect(attachment).toBeVisible();
    assert.equal(f.calls.filter((c) => c.method === "turn/start").length, 0);
    console.log(engine + ": late attachment inventory preserves the newly uploaded draft file");
  } finally {
    await context.close();
    await browser.close();
    await f.close();
  }
}
