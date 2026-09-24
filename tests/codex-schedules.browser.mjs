import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { chromium, expect, webkit } from "@playwright/test";
import { handoffFixture } from "./handoff-fixture.mjs";

const engine = process.env.BROWSER || "webkit",
  origin = "http://127.0.0.1:18876";
const f = await handoffFixture(origin, undefined, {
  configure(config) {
    config.projects[0].name = "Проект с очень длинным названием для проверки панели расписания";
  },
});
const browser = await (engine === "webkit" ? webkit : chromium).launch();
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  serviceWorkers: "block",
});
try {
  await f.app.listen({ port: 18876, host: "127.0.0.1" });
  await f.release();
  const [name, value] = f.headers.cookie.split("=");
  await context.addCookies([{ name, value, url: origin, httpOnly: true, sameSite: "Strict" }]);
  await context.addInitScript(
    ({ id }) => {
      localStorage.setItem("codex-project", "project");
      localStorage.setItem("codex-thread", id);
    },
    { id: f.thread.id },
  );
  const page = await context.newPage(),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("response", async (r) => {
    if (r.url().includes("/schedules/") && !r.ok())
      console.log("SCHEDULE ERROR", r.status(), await r.text());
  });
  await page.goto(origin);
  const composer = page.getByRole("textbox", { name: "Сообщение Codex", exact: true });
  await expect(composer).toBeVisible();
  await composer.fill("Обычный черновик остаётся в чате");
  await page.getByRole("button", { name: "Сообщения по расписанию", exact: true }).click();
  const win = page.getByRole("dialog", { name: "Сообщения по расписанию", exact: true });
  await win.getByRole("button", { name: "Новое сообщение", exact: true }).click();
  await win
    .getByRole("textbox", { name: "Сообщение", exact: true })
    .fill("Проверь результаты ночной сборки и подготовь краткий итог.");
  await win.getByLabel("Повтор", { exact: true }).selectOption("repeat");
  await mkdir(".local/qa-codex-schedules", { recursive: true });
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
      const box = await win.boundingBox(),
        save = await win.getByRole("button", { name: "Сохранить", exact: true }).boundingBox();
      assert(
        box.x >= 0 &&
          box.x + box.width <= width + 1 &&
          box.y >= 0 &&
          box.y + box.height <= height + 1,
      );
      assert(save.y >= 0 && save.y + save.height <= height + 1 && save.height >= 44);
      assert(await win.evaluate((e) => e.scrollWidth <= e.clientWidth + 1));
      await page.screenshot({
        path: `.local/qa-codex-schedules/${engine}-${theme}-${width}x${height}.png`,
        animations: "disabled",
      });
    }
  }
  await win.getByRole("button", { name: "Закрыть расписание", exact: true }).click();
  await expect(composer).toHaveValue("Обычный черновик остаётся в чате");
  await page.getByRole("button", { name: "Сообщения по расписанию", exact: true }).click();
  await expect(win.getByRole("textbox", { name: "Сообщение", exact: true })).toHaveValue(
    "Проверь результаты ночной сборки и подготовь краткий итог.",
  );
  await win.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(win.locator(".schedule-card")).toHaveCount(1);
  await win.getByRole("button", { name: "Пауза", exact: true }).click();
  await expect(win.locator(".schedule-card")).toContainText("Приостановлено");
  await win.getByRole("button", { name: "Продолжить", exact: true }).click();
  await expect(win.locator(".schedule-card")).toContainText("Запланировано");
  await win.getByRole("button", { name: "Изменить", exact: true }).click();
  await win.getByRole("textbox", { name: "Сообщение", exact: true }).fill("Новая версия сообщения");
  await win.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(win.locator(".schedule-card")).toContainText("Новая версия сообщения");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: `.local/qa-codex-schedules/${engine}-list.png`,
    animations: "disabled",
  });
  await win.getByRole("button", { name: "Отменить", exact: true }).click();
  await expect(win.locator(".schedule-card")).toContainText("Отменено");
  await win.getByRole("button", { name: "Закрыть расписание", exact: true }).click();
  await expect(composer).toHaveValue("Обычный черновик остаётся в чате");
  await page.screenshot({
    path: `.local/qa-codex-schedules/${engine}-toolbar.png`,
    animations: "disabled",
  });
  assert.equal(f.calls.filter((c) => c.method === "turn/start").length, 0);
  const at = new Date(Date.now() + 120000).toISOString();
  const scheduled = await f.app.inject({
    method: "POST",
    url: `/api/projects/project/schedules/work/${f.thread.id}`,
    headers: { ...f.headers, "idempotency-key": randomUUID() },
    payload: {
      text: "Notification recovery",
      targetRevision: 1,
      rule: { date: at.slice(0, 10), time: at.slice(11, 16), timezone: "UTC", weekdays: [] },
    },
  });
  assert.equal(scheduled.statusCode, 200, scheduled.body);
  f.loseAck();
  f.codexSchedules.now = () => scheduled.json().nextAt;
  await f.codexSchedules.tick();
  const notice = f.store.db.prepare("SELECT id FROM push_notices WHERE kind='schedule'").get();
  await page.evaluate((id) => {
    location.hash = "notification=" + id;
  }, notice.id);
  await expect(win).toBeVisible();
  await expect(win).toContainText("Подтверждение не получено");
  await win.getByRole("button", { name: "Закрыть расписание", exact: true }).click();
  await expect(composer).toHaveValue("Обычный черновик остаётся в чате");
  assert.equal(f.calls.filter((c) => c.method === "turn/start").length, 1);
  assert.deepEqual(errors, []);
  console.log(
    engine +
      ": Codex schedule create/edit/pause/resume/cancel, isolated drafts, four themes and keyboard geometry passed",
  );
} finally {
  await context.close();
  await browser.close();
  await f.close();
}
