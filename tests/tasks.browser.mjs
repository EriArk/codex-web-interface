import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { chromium, expect, webkit } from "@playwright/test";
import { Library } from "../apps/hub/dist/library.js";
import { WorkspaceTasks } from "../apps/hub/dist/tasks.js";
import { handoffFixture } from "./handoff-fixture.mjs";

await mkdir(".local/qa-tasks", { recursive: true });
for (const [engine, type] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
  const origin = "http://127.0.0.1:18856",
    f = await handoffFixture(origin),
    tasks = new WorkspaceTasks(f.sessions);
  const otherScope = { client: "gpt", projectId: "g-tasks", name: "Другой проект" };
  new Library(f.store, "gpt").save("project", otherScope.projectId, { name: otherScope.name });
  const globalTask = tasks.save(randomUUID(), {
    scope: null,
    title: "Личное напоминание",
    body: "Global",
    links: [],
    revision: 0,
    status: "todo",
    priority: 1,
    dueAt: null,
  });
  tasks.save(randomUUID(), { ...globalTask, scope: otherScope, title: "GPT задача", revision: 0 });
  f.store.setPreferences({
    projectId: "project",
    threadId: f.thread.id,
    theme: "crt-green",
    view: "chat",
  });
  f.store.db.prepare("UPDATE threads SET origin='web' WHERE id=?").run(f.thread.id);
  const result = f.store.result(
    f.thread.id,
    "task-turn",
    "task-source",
    "check",
    "Проверка каталога",
    { text: "Проверка прошла" },
  );
  const browser = await type.launch(),
    context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      serviceWorkers: "block",
    });
  try {
    await f.app.listen({ port: 18856, host: "127.0.0.1" });
    const [name, value] = f.headers.cookie.split("=");
    await context.addCookies([{ name, value, url: origin, httpOnly: true, sameSite: "Strict" }]);
    const page = await context.newPage(),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(origin);
    const chat = page.getByRole("textbox", { name: "Сообщение Codex" });
    await expect(chat).toBeVisible();
    await chat.fill("Мой черновик Codex");
    const open = async () => {
      if (page.viewportSize().width < 800)
        await page.getByRole("button", { name: "Открыть проекты" }).click();
      await page
        .getByRole("button", { name: "Задачи", exact: true })
        .filter({ visible: true })
        .click();
    };
    await open();
    const panel = page.getByRole("dialog", { name: "Задачи", exact: true });
    await expect(panel).toBeVisible();
    await expect(panel.getByRole("combobox", { name: "Проекты задач" })).toHaveValue("all");
    await expect(
      panel.locator(".notebook-row").filter({ hasText: "Личное напоминание" }),
    ).toBeVisible();
    await expect(panel.locator(".notebook-row").filter({ hasText: "GPT задача" })).toBeVisible();
    await panel
      .getByRole("combobox", { name: "Проекты задач" })
      .selectOption({ label: "Без проекта" });
    await expect(panel.locator(".notebook-row").filter({ hasText: "GPT задача" })).toHaveCount(0);
    await panel
      .getByRole("combobox", { name: "Проекты задач" })
      .selectOption({ label: "Другой проект · GPT" });
    await expect(panel.locator(".notebook-row").filter({ hasText: "GPT задача" })).toBeVisible();
    await panel
      .getByRole("combobox", { name: "Проекты задач" })
      .selectOption({ label: "Project · Codex" });
    await expect(panel.locator(".notebook-row").filter({ hasText: "GPT задача" })).toHaveCount(0);
    await panel.getByRole("button", { name: "Новая задача", exact: true }).tap();
    const title = panel.getByRole("textbox", { name: "Название задачи" }),
      body = panel.getByRole("textbox", { name: "Описание задачи" });
    await expect(
      panel.getByRole("combobox", { name: "Проект задачи" }).locator("option[value='gpt:g-tasks']"),
    ).toHaveCount(1);
    await title.fill("Проверить читалку");
    await body.fill("Проверить место чтения после сна.");
    await panel.getByRole("combobox", { name: "Статус задачи" }).selectOption("doing");
    await panel.getByRole("combobox", { name: "Приоритет задачи" }).selectOption("2");
    await panel.getByLabel("Срок задачи").fill("2026-09-09");
    await page.screenshot({ path: `.local/qa-tasks/${engine}-phone-edit.png` });
    await panel.getByRole("button", { name: "Закрыть задачи" }).tap();
    await expect(chat).toHaveValue("Мой черновик Codex");
    await page.reload();
    await open();
    await panel
      .getByRole("region", { name: "Черновики задач" })
      .getByRole("button")
      .first()
      .click();
    await expect(body).toHaveValue("Проверить место чтения после сна.");
    await expect(panel.getByRole("combobox", { name: "Статус задачи" })).toHaveValue("doing");
    await expect(panel.getByLabel("Срок задачи")).toHaveValue("2026-09-09");
    await panel.getByRole("button", { name: "Сохранить", exact: true }).tap();
    await expect(panel.locator(".notebook-status")).toContainText("Сохранено");
    const task = tasks.list("codex:project", "open", "читалку", 0, "").items[0];
    assert.equal(tasks.get(task.id).links[0].id, f.thread.id);
    await panel.getByRole("button", { name: "К списку задач" }).tap();
    await panel.getByRole("button", { name: "Завершить: Проверить читалку" }).tap();
    await expect(panel.getByRole("button", { name: "Завершить: Проверить читалку" })).toHaveCount(
      0,
    );
    assert.equal(tasks.get(task.id).status, "done");
    await panel.getByRole("combobox", { name: "Состояние задач" }).selectOption("done");
    await expect(
      panel.getByRole("button", { name: "Вернуть в работу: Проверить читалку" }),
    ).toBeVisible();
    await page.screenshot({ path: `.local/qa-tasks/${engine}-phone-list.png` });
    await panel.getByRole("button", { name: "Вернуть в работу: Проверить читалку" }).tap();
    await expect.poll(() => tasks.get(task.id).status).toBe("todo");
    await panel.getByRole("combobox", { name: "Состояние задач" }).selectOption("open");
    await panel
      .locator(".notebook-row")
      .filter({ hasText: "Проверить читалку" })
      .getByRole("button")
      .last()
      .click();
    await panel.getByRole("button", { name: "Закрепить задачу" }).click();
    await panel.getByRole("button", { name: "К списку задач" }).click();
    await panel
      .getByRole("region", { name: "Закреплённые", exact: true })
      .getByRole("button", { name: "Проверить читалку", exact: true })
      .click();
    await expect(title).toHaveValue("Проверить читалку");
    await panel.getByRole("button", { name: "Закрыть задачи" }).click();
    // A Result creates a reference-only task and can navigate back after the task is saved.
    await page
      .locator(".mobile-tabs")
      .getByRole("button", { name: /Результаты/ })
      .click();
    await page
      .getByRole("button", { name: "Сохранить ссылку: Проверка каталога", exact: true })
      .click();
    const notes = page.getByRole("dialog", { name: "Заметки и ссылки", exact: true });
    await notes.getByRole("button", { name: "Создать задачу по ссылке", exact: true }).click();
    await panel.getByRole("button", { name: "Новая задача", exact: true }).click();
    await title.fill("Проверить результат");
    await expect(body).toHaveValue("");
    await panel.getByRole("button", { name: "Сохранить", exact: true }).click();
    await expect(panel.locator(".notebook-status")).toContainText("Сохранено");
    const linked = tasks.list("codex:project", "open", "результат", 0, "").items[0];
    assert.equal(tasks.get(linked.id).links[0].id, result);
    await panel
      .locator(".notebook-links")
      .getByRole("button", { name: "Проверка каталога", exact: true })
      .click();
    await expect(page.locator(`[data-result="${result}"]`)).toBeVisible();
    await expect(panel).not.toBeVisible();
    await page.setViewportSize({ width: 1366, height: 1024 });
    await page
      .getByRole("button", { name: "Настройки", exact: true })
      .filter({ visible: true })
      .first()
      .click();
    await page.locator('.settings-browser[open] [data-category="appearance"]').click();
    await page.locator(".theme-option.hitech-2000s input").check();
    await page.getByRole("button", { name: "Закрыть настройки", exact: true }).click();
    await open();
    await expect(panel.getByRole("combobox", { name: "Проекты задач" })).toHaveValue("all");
    await page.screenshot({ path: `.local/qa-tasks/${engine}-tablet.png` });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await panel.getByRole("button", { name: "Закрыть задачи" }).click();
    await page
      .getByRole("button", { name: "Переключиться на GPT" })
      .filter({ visible: true })
      .click();
    const gpt = page.getByRole("textbox", { name: "Сообщение GPT" });
    await expect(gpt).toBeVisible();
    await gpt.fill("Мой черновик GPT");
    await open();
    await expect(panel.getByRole("combobox", { name: "Проекты задач" })).toHaveValue("all");
    await expect(
      panel.locator(".notebook-row").filter({ hasText: "Проверить результат" }),
    ).toBeVisible();
    await panel.getByRole("button", { name: "Закрыть задачи" }).click();
    await expect(gpt).toHaveValue("Мой черновик GPT");
    assert.deepEqual(errors, []);
    assert.equal(
      f.calls.filter((c) => ["thread/resume", "turn/start"].includes(c.method)).length,
      0,
    );
    assert.equal(f.desktopCalls.filter((c) => c !== "Status").length, 0);
    console.log(
      engine +
        ": task drafts, fields, completion/reopen, pins, Result backlinks, phone/tablet and GPT continuity passed",
    );
  } finally {
    await context.close();
    await browser.close();
    await f.close();
  }
}
