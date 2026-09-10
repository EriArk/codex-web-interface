import assert from "node:assert/strict";
import { chromium, expect, webkit } from "@playwright/test";
import { handoffFixture } from "./handoff-fixture.mjs";

for (const [name, type] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
  const origin = "http://127.0.0.1:18842",
    f = await handoffFixture(origin),
    browser = await type.launch();
  const context = await browser.newContext({
    viewport: { width: 1366, height: 1024 },
    serviceWorkers: "block",
  });
  try {
    await f.app.listen({ port: 18842, host: "127.0.0.1" });
    const [nameCookie, value] = f.headers.cookie.split("=");
    await context.addCookies([
      { name: nameCookie, value, url: origin, secure: false, httpOnly: true, sameSite: "Strict" },
    ]);
    const page = await context.newPage(),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    let missed = 0;
    await page.route("**/assets/GptWorkspace-*.js", (r) => {
      missed++;
      return r.fulfill({ status: 404, body: "missing old release asset" });
    });
    await page.goto(origin);
    const picker = page.getByRole("button", { name: "Переключиться на GPT" });
    await expect(picker).toBeVisible();
    await picker.click();
    await expect.poll(() => missed).toBe(1);

    await expect(page.getByRole("alert")).toContainText("Не удалось загрузить GPT");
    await expect(page.getByRole("button", { name: "Обновить", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Вернуться в Codex" }).click();
    await expect(picker).toBeVisible();
    assert.deepEqual(errors, []);
    console.log(
      name + ": missing lazy GPT chunk shows recovery controls and allows return to Codex",
    );
  } finally {
    await context.close();
    await browser.close();
    await f.close();
  }
}
