import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { chromium, expect, webkit } from "@playwright/test";
import { nativePlanFixture } from "./native-plan-fixture.mjs";

await mkdir(".local/qa-native-plan", { recursive: true });
for (const [engine, type] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
  const origin = "http://127.0.0.1:18864",
    f = await nativePlanFixture(origin);
  const plan = await f.plan();
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
  const page = await context.newPage(),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await f.app.listen({ port: 18864, host: "127.0.0.1" });
    const [name, value] = f.headers.cookie.split("=");
    await context.addCookies([{ name, value, url: origin, httpOnly: true, sameSite: "Strict" }]);
    await page.goto(origin);
    const draft = page.getByRole("textbox", { name: "Сообщение Codex", exact: true });
    await expect(draft).toBeVisible();
    await draft.fill("Мой отдельный черновик, не отправляй его вместе с планом.");
    const button = page.getByRole("button", { name: "Реализовать этот план", exact: true });
    await expect(button).toBeVisible();
    for (const [width, height] of [
      [390, 844],
      [768, 1024],
      [1024, 768],
      [1280, 800],
      [1376, 1032],
    ]) {
      await page.setViewportSize({ width, height });
      if (width < 1100) {
        await expect(page.locator(".desktop-nav")).toBeHidden();
        await expect(page.locator(".wide-pane-control")).toBeHidden();
        await page
          .getByRole("navigation", { name: "Разделы рабочего пространства" })
          .getByRole("button", { name: /Результаты/ })
          .click();
        await expect(
          page.getByRole("textbox", { name: "Сообщение Codex", exact: true }),
        ).toBeHidden();
        await page
          .getByRole("navigation", { name: "Разделы рабочего пространства" })
          .getByRole("button", { name: "Чат", exact: true })
          .click();
        await expect(draft).toHaveValue(
          "Мой отдельный черновик, не отправляй его вместе с планом.",
        );
      }
      for (const theme of ["organizer", "crt-green", "hitech-2000s", "classic-dark"]) {
        await page.evaluate((theme) => {
          document.documentElement.dataset.theme = theme;
        }, theme);
        await button.scrollIntoViewIfNeeded();
        await expect(button).toBeVisible();
        const box = await button.boundingBox();
        assert(box.width > 150 && box.height >= 44);
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
          false,
        );
        await page.screenshot({ path: `.local/qa-native-plan/${engine}-${theme}-${width}.png` });
      }
    }
    // Both browser acknowledgement and native acknowledgement may be lost independently.
    f.loseAck();
    await button.click();
    await expect(page.getByRole("button", { name: "Проверить запуск", exact: true })).toBeVisible();
    await expect(button).toHaveCount(0);
    await expect(draft).toHaveValue("Мой отдельный черновик, не отправляй его вместе с планом.");
    await page.reload();
    const check = page.getByRole("button", { name: "Проверить запуск", exact: true });
    await expect(check).toBeVisible();
    await check.click();
    await expect(page.getByText("Реализация запущена в этом чате.", { exact: true })).toBeVisible();
    await expect(check).toHaveCount(0);
    await expect(draft).toHaveValue("Мой отдельный черновик, не отправляй его вместе с планом.");
    assert.equal(f.calls.filter((c) => c.method === "turn/start").length, 2);
    assert.equal(
      f.calls.filter((c) => c.method === "turn/start").at(-1).params.input[0].text,
      `PLEASE IMPLEMENT THIS PLAN:\n${plan.text}`,
    );
    const other = f.store.createThread("project", randomUUID(), "Another conversation");
    f.store.setPreferences({ threadId: other.id });
    await page.reload();
    await expect(page.locator(`[data-message="${plan.id}"]`)).toHaveCount(0);
    await expect(button).toHaveCount(0);
    await expect(page.getByText("Реализация запущена в этом чате.", { exact: true })).toHaveCount(
      0,
    );
    assert.deepEqual(errors, []);
    console.log(
      `${engine}: native Plan/Work, uncertain receipt/reload, exact once, preserved draft and phone/tablet themes passed`,
    );
  } catch (error) {
    await page.screenshot({ path: `.local/qa-native-plan/${engine}-failure.png` });
    throw error;
  } finally {
    await browser.close();
    await f.close();
  }
}
