import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, expect, webkit } from "@playwright/test";
import { communicationFixture } from "./communication-fixture.mjs";

const engine = process.env.BROWSER ?? "webkit",
  f = await communicationFixture(),
  browser = await (engine === "webkit" ? webkit : chromium).launch();
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  serviceWorkers: "allow",
});
const [name, value] = f.headers.cookie.split("=");
await context.addCookies([{ name, value, url: f.base, httpOnly: true, sameSite: "Strict" }]);
const page = await context.newPage(),
  errors = [];
page.on("pageerror", (e) => errors.push(e.message));
try {
  await page.goto(f.base);
  await expect(page.getByRole("button", { name: "Открыть проекты", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Открыть проекты", exact: true }).click();
  await page.getByRole("button", { name: "Общение", exact: true }).last().click();
  const win = page.locator(".communication-window");
  await win.getByRole("button", { name: "Люди", exact: true }).click();
  await win.getByRole("button", { name: /Друг/ }).click();
  const compose = win.getByRole("textbox", { name: "Сообщение участникам", exact: true });
  await expect(compose).toBeVisible();
  await compose.fill("Привет! Всё получилось.");
  await win.getByRole("button", { name: "Отправить в общий чат", exact: true }).click();
  await expect(win.locator(".space-chat-message")).toContainText("Привет!");
  await compose.fill("Личный черновик");
  await win.getByRole("button", { name: "Добавить к сообщению", exact: true }).click();
  await expect(win.getByRole("button", { name: "Файл", exact: true })).toBeVisible();
  await expect(win.getByRole("button", { name: "Ссылка", exact: true })).toBeVisible();
  await win.getByRole("button", { name: "Добавить к сообщению", exact: true }).click();

  await win.getByRole("button", { name: "Создать группу", exact: true }).click();
  await win
    .getByRole("textbox", { name: "Название группы", exact: true })
    .fill("Дизайн и разработка очень интересного общего проекта");
  await win.locator(".communication-create").getByRole("button", { name: /Друг/ }).click();
  await mkdir(".local/qa-messenger", { recursive: true });
  for (const theme of ["organizer", "crt-green", "hitech-2000s", "classic-dark"]) {
    await page.evaluate((t) => {
      document.documentElement.dataset.theme = t;
      document.documentElement.dataset.caseColor =
        t === "hitech-2000s" ? "turquoise" : t === "classic-dark" ? "blue" : "green";
    }, theme);
    await page.waitForTimeout(150);
    await page.screenshot({
      animations: "disabled",
      path: `.local/qa-messenger/${engine}-${theme}-group.png`,
    });
  }
  await win.locator("footer").getByRole("button", { name: "Создать группу", exact: true }).click();
  await expect(win.locator(".communication-chat-heading")).toContainText("2 участников");
  await compose.fill("Групповой черновик");
  await win.getByRole("button", { name: "К списку чатов", exact: true }).click();
  await win.getByRole("button", { name: "Чаты", exact: true }).click();
  await win.getByRole("button", { name: "Друг", exact: true }).click();
  await expect(compose).toHaveValue("Личный черновик");
  await win.getByRole("button", { name: "К списку чатов", exact: true }).click();
  await mkdir(".local/qa-messenger", { recursive: true });
  for (const theme of ["organizer", "crt-green", "hitech-2000s", "classic-dark"]) {
    for (const [width, height] of [
      [390, 844],
      [390, 500],
      [768, 1024],
      [1024, 768],
      [1366, 1024],
    ]) {
      await page.setViewportSize({ width, height });
      await page.evaluate((t) => {
        document.documentElement.dataset.theme = t;
        document.documentElement.dataset.caseColor =
          t === "hitech-2000s" ? "turquoise" : t === "classic-dark" ? "blue" : "green";
      }, theme);
      await page.waitForTimeout(150);
      assert(await win.evaluate((el) => el.scrollWidth <= el.clientWidth + 1));
      await page.screenshot({
        animations: "disabled",
        path: `.local/qa-messenger/${engine}-${theme}-${width}x${height}-list.png`,
      });
      await win.getByRole("button", { name: "Друг", exact: true }).click();
      await expect(compose).toHaveValue("Личный черновик");
      await page.screenshot({
        animations: "disabled",
        path: `.local/qa-messenger/${engine}-${theme}-${width}x${height}-chat.png`,
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await win.getByRole("button", { name: "К списку чатов", exact: true }).click();
    }
  }
  await win.getByRole("button", { name: "Люди", exact: true }).click();
  await win.getByRole("button", { name: /Друг/ }).click();
  await expect(compose).toHaveValue("Личный черновик");
  const items = (await f.request(f.headers, "GET", "/api/team/conversations")).json().items;
  assert.equal(items.filter((c) => c.kind === "direct").length, 1);
  assert.equal(items.filter((c) => c.kind === "group").length, 1);
  assert.deepEqual(errors, []);
  console.log(engine + " messenger browser passed");
} finally {
  await browser.close();
  await f.close();
}
