import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, expect, webkit } from "@playwright/test";
import { relayFixture } from "./relays-fixture.mjs";

await mkdir(".local/qa-relays", { recursive: true });
for (const [engine, type] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
  const origin = "http://127.0.0.1:18889",
    f = await relayFixture(origin);
  f.store.setPreferences({
    projectId: "project",
    threadId: f.thread.id,
    theme: "crt-green",
    view: "chat",
  });
  f.store.setStatus(f.target.id, "running", "owner-work");
  const browser = await type.launch(),
    context = await browser.newContext({
      viewport: { width: 393, height: 852 },
      hasTouch: true,
      serviceWorkers: "block",
    });
  try {
    await f.app.listen({ port: 18889, host: "127.0.0.1" });
    const [name, value] = f.headers.cookie.split("=");
    await context.addCookies([{ name, value, url: origin, httpOnly: true, sameSite: "Strict" }]);
    const page = await context.newPage(),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(origin);
    const composer = page.getByRole("textbox", { name: "Сообщение Codex" });
    await composer.fill("Мой черновик");
    const open = () => page.getByRole("button", { name: "Обзор текущего проекта" }).click();
    await open();
    const panel = page.getByRole("region", { name: "Связанные проекты", exact: true });
    await expect(panel.getByText("Target", { exact: true })).toBeVisible();
    await panel.locator(".relay-link summary").click();
    const slider = panel.getByRole("slider", { name: "Глубина обмена: Target" });
    await slider.focus();
    await slider.press("ArrowRight");
    await slider.press("ArrowRight");
    await panel.getByRole("button", { name: "Сохранить", exact: true }).click();
    await expect.poll(() => f.service.link(f.link.id).depth).toBe(5);
    await panel.getByRole("button", { name: "Новый запрос", exact: true }).click();
    await panel.getByLabel("Тема", { exact: true }).fill("Проверка совместимости");
    await panel
      .getByRole("textbox", { name: "Запрос", exact: true })
      .fill("Сверь интерфейс без изменений файлов");
    await page.reload();
    await open();
    await expect(panel.getByRole("textbox", { name: "Запрос", exact: true })).toHaveValue(
      "Сверь интерфейс без изменений файлов",
    );
    await panel.getByRole("button", { name: "Отправить", exact: true }).click();
    await expect.poll(() => f.service.page("project").items.length).toBe(1);
    assert.equal(f.calls.filter((c) => c.method === "turn/start").length, 0);
    await expect(composer).toHaveValue("Мой черновик");
    await panel.locator(".relay-entry summary").click();
    for (const theme of ["crt-green", "hitech-2000s", "organizer", "classic-dark"]) {
      await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
      for (const width of [393, 1366]) {
        await page.setViewportSize({ width, height: width === 393 ? 852 : 1024 });
        await panel.scrollIntoViewIfNeeded();
        assert(await panel.evaluate((e) => e.scrollWidth <= e.clientWidth + 2));
        await page.screenshot({
          path: `.local/qa-relays/${engine}-${theme}-${width}.png`,
          animations: "disabled",
        });
      }
    }
    const actionResponse = page.waitForResponse((r) => r.url().endsWith("/action"));
    await panel.getByRole("button", { name: "Остановить обмен", exact: true }).click();
    const stoppedResponse = await actionResponse;
    assert.equal(stoppedResponse.status(), 200, await stoppedResponse.text());
    await expect.poll(() => f.service.page("project").items[0].state).toBe("stopped");
    assert.equal(f.calls.filter((c) => c.method === "turn/start").length, 0);
    assert.deepEqual(errors, []);
    console.log(
      engine +
        ": per-link slider, persisted request, no interrupted target, owner stop, preserved chat draft and four-theme phone/tablet panels passed",
    );
  } finally {
    await context.close();
    await browser.close();
    await f.close();
  }
}
