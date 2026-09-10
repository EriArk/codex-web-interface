import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, expect, webkit } from "@playwright/test";
import { handoffFixture } from "./handoff-fixture.mjs";

await mkdir(".local/qa-work", { recursive: true });
for (const [engine, type] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
  const origin = "http://127.0.0.1:18860",
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
    await f.app.listen({ port: 18860, host: "127.0.0.1" });
    const [name, value] = f.headers.cookie.split("=");
    await context.addCookies([{ name, value, url: origin, httpOnly: true, sameSite: "Strict" }]);
    const page = await context.newPage(),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(origin);
    const chat = page.getByRole("textbox", { name: "Сообщение Codex" });
    await expect(chat).toBeVisible();
    await chat.fill("Мой несвязанный черновик");
    await page.getByRole("button", { name: "Обзор текущего проекта" }).click();
    await page
      .getByRole("region", { name: "Планы проекта", exact: true })
      .getByRole("button", { name: "Открыть", exact: true })
      .click();
    let panel = page.getByRole("dialog", { name: "Планы", exact: true });
    await panel.getByRole("button", { name: "Новый план", exact: true }).click();
    await panel
      .getByRole("textbox", { name: "Название плана", exact: true })
      .fill("Мобильная навигация");
    await panel
      .getByRole("textbox", { name: "Описание плана", exact: true })
      .fill("Сохранить жесты и черновики");
    await panel.getByRole("button", { name: "Добавить пункт", exact: true }).click();
    await panel
      .getByRole("textbox", { name: "Пункт плана", exact: true })
      .nth(0)
      .fill("Подготовить меню");
    await panel.getByRole("button", { name: "Добавить пункт", exact: true }).click();
    await panel
      .getByRole("textbox", { name: "Пункт плана", exact: true })
      .nth(1)
      .fill("Проверить на телефоне");
    await panel.getByRole("checkbox", { name: "Выполнено: Подготовить меню", exact: true }).check();
    await panel.getByRole("button", { name: "Закрыть рабочий раздел" }).click();
    await page
      .getByRole("region", { name: "Планы проекта", exact: true })
      .getByRole("button", { name: "Открыть", exact: true })
      .click();
    await panel.getByRole("button", { name: /Мобильная навигация.*Черновик/ }).click();
    await expect(panel.getByRole("textbox", { name: "Пункт плана" }).nth(1)).toHaveValue(
      "Проверить на телефоне",
    );
    let lost = false;
    await page.route("**/api/workspace/plans/*", async (route) => {
      if (!lost && route.request().method() === "PUT") {
        lost = true;
        await route.fetch();
        await route.abort("failed");
      } else await route.continue();
    });
    await panel.getByRole("button", { name: "Сохранить", exact: true }).click();
    await expect(panel.getByRole("alert")).toBeVisible();
    await panel.getByRole("button", { name: "Сохранить", exact: true }).click();
    await expect(panel.getByRole("status").filter({ hasText: "Сохранено" })).toHaveText(
      "Сохранено",
    );
    assert.equal(f.store.db.prepare("SELECT count(*) n FROM project_plans").get().n, 1);
    const removed = f.store.db.prepare("SELECT id FROM project_plans").get().id;
    f.store.db.prepare("DELETE FROM project_plans WHERE id=?").run(removed);
    await panel
      .getByRole("textbox", { name: "Описание плана", exact: true })
      .fill("Черновик после удаления на другом устройстве");
    await panel.getByRole("button", { name: "Сохранить", exact: true }).click();
    await page.screenshot({ path: `.local/qa-work/${engine}-deleted-plan.png` });
    await panel.getByRole("button", { name: "Сохранить как новый", exact: true }).click();
    await expect(panel.getByRole("status").filter({ hasText: "Сохранено" })).toHaveText(
      "Сохранено",
    );
    assert.equal(f.store.db.prepare("SELECT count(*) n FROM project_plans").get().n, 1);
    assert.notEqual(f.store.db.prepare("SELECT id FROM project_plans").get().id, removed);
    await panel.getByRole("button", { name: "Реализовать", exact: true }).click();
    const action = panel.getByRole("region", { name: "Задание проекта" });
    await expect(action.getByText("Готово к запуску", { exact: true })).toBeVisible();
    assert.equal(f.calls.filter((c) => c.method === "turn/start").length, 0);
    await action.getByRole("button", { name: "Подтвердить и запустить" }).click();
    await expect(action.getByText("В работе", { exact: true })).toBeVisible();
    assert.equal(f.calls.filter((c) => c.method === "turn/start").length, 1);
    f.store.append(
      f.thread.id,
      "assistant.completed",
      { id: "work-final", text: "Готово.", phase: "final" },
      f.store.thread(f.thread.id).activeTurnId,
    );
    f.finishTurn();
    await expect(action.getByText("Ответ готов", { exact: true })).toBeVisible({ timeout: 10000 });
    for (const theme of ["classic-dark", "organizer", "crt-green", "hitech-2000s"]) {
      await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
      for (const width of [390, 1366]) {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 1024 });
        await page.screenshot({ path: `.local/qa-work/${engine}-plans-${theme}-${width}.png` });
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      }
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await panel.getByRole("button", { name: "Отчёты", exact: true }).click();
    panel = page.getByRole("dialog", { name: "Отчёты", exact: true });
    await panel.getByRole("button", { name: "Подготовить отчёт", exact: true }).click();
    const reportAction = panel.getByRole("region", { name: "Задание проекта" });
    await reportAction.getByRole("button", { name: "Подтвердить и запустить" }).click();
    await expect(reportAction.getByText("В работе", { exact: true })).toBeVisible();
    f.store.append(
      f.thread.id,
      "assistant.completed",
      {
        id: "report-final",
        text: "# Проверено\n\nМеню готово. Осталась проверка устройства.",
        phase: "final",
      },
      f.store.thread(f.thread.id).activeTurnId,
    );
    f.finishTurn();
    await expect(reportAction.getByText("Ответ готов", { exact: true })).toBeVisible({
      timeout: 10000,
    });
    await panel.getByRole("button", { name: "К списку", exact: true }).click();
    await panel
      .getByRole("complementary", { name: "История отчётов" })
      .getByRole("button")
      .filter({ hasText: "Первый отчёт" })
      .click();
    await expect(
      panel.getByText("Меню готово. Осталась проверка устройства.", { exact: true }),
    ).toBeVisible();
    await expect(panel.getByRole("button", { name: "Копировать отчёт" })).toBeVisible();
    await page.screenshot({ path: `.local/qa-work/${engine}-report-phone.png` });
    await panel.getByRole("button", { name: "Закрыть рабочий раздел" }).click();
    await page
      .getByRole("region", { name: "Продолжить работу" })
      .getByRole("button")
      .first()
      .click();
    await expect(chat).toHaveValue("Мой несвязанный черновик");
    const callsBeforeRepair = f.calls.length;
    const missing = "00000000-0000-4000-8000-000000000000";
    f.store.db
      .prepare("UPDATE project_current_chats SET threadId=? WHERE scopeKey='codex:project'")
      .run(missing);
    await page.getByRole("button", { name: "Обзор текущего проекта" }).click();
    const repair = page.getByRole("button", {
      name: /^Сделать рабочим:/,
      exact: true,
    });
    await expect(repair).toBeVisible();
    await repair.click();
    await expect(page.getByText("Текущий чат", { exact: true })).toBeVisible();
    assert.equal(
      f.store.db
        .prepare("SELECT threadId FROM project_current_chats WHERE scopeKey='codex:project'")
        .get().threadId,
      f.thread.id,
    );
    assert.equal(
      f.calls
        .slice(callsBeforeRepair)
        .filter((c) => ["turn/start", "thread/start"].includes(c.method)).length,
      0,
    );
    assert.deepEqual(errors, []);
    console.log(
      engine +
        ": plans/drafts/lost acknowledgement/confirmed execution/report checkpoint/themes passed",
    );
  } finally {
    await context.close();
    await browser.close();
    await f.close();
  }
}
