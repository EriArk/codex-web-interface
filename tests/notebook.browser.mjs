import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { chromium, expect, webkit } from "@playwright/test";
import { Notebook } from "../apps/hub/dist/notebook.js";
import { handoffFixture } from "./handoff-fixture.mjs";

await mkdir(".local/qa-notebook", { recursive: true });
for (const [engine, type] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
  const origin = "http://127.0.0.1:18855",
    f = await handoffFixture(origin),
    book = new Notebook(f.sessions);
  f.store.setPreferences({
    projectId: "project",
    threadId: f.thread.id,
    theme: "crt-green",
    view: "chat",
  });
  f.store.db.prepare("UPDATE threads SET origin='web' WHERE id=?").run(f.thread.id);
  const errors = [],
    browser = await type.launch(),
    context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      serviceWorkers: "block",
    });
  try {
    await f.app.listen({ port: 18855, host: "127.0.0.1" });
    const [name, value] = f.headers.cookie.split("=");
    await context.addCookies([{ name, value, url: origin, httpOnly: true, sameSite: "Strict" }]);
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(origin);
    const chat = page.getByRole("textbox", { name: "Сообщение Codex" });
    await expect(chat).toBeVisible();
    await chat.fill("Черновик чата сохранён");
    const open = async () => {
      if ((await page.viewportSize()).width < 800)
        await page.getByRole("button", { name: "Открыть проекты" }).click();
      await page
        .getByRole("button", { name: "Заметки", exact: true })
        .filter({ visible: true })
        .click();
    };
    const panel = page.getByRole("dialog", { name: "Заметки и ссылки", exact: true });
    await open();
    await expect(panel).toBeVisible();
    await panel
      .getByRole("group", { name: "Проекты заметок" })
      .getByRole("button", { name: "Project · Codex", exact: true })
      .click();
    await panel.getByRole("button", { name: "Новая заметка", exact: true }).tap();
    const title = panel.getByRole("textbox", { name: "Название заметки" }),
      body = panel.getByRole("textbox", { name: "Текст заметки" });
    await title.fill("Контекст книжного проекта");
    await body.fill(
      "# Решение\n\nСохранить позицию чтения.\n\n```txt\ncopy exact  \n  indented\n```",
    );
    await page.screenshot({ path: `.local/qa-notebook/${engine}-phone-edit.png` });
    await panel.getByRole("button", { name: "Закрыть заметки" }).tap();
    await expect(chat).toHaveValue("Черновик чата сохранён");
    await page.reload();
    await open();
    await panel
      .getByRole("region", { name: "Черновики заметок" })
      .getByRole("button")
      .first()
      .click();
    await expect(body).toContainText("Сохранить позицию чтения.");
    await panel.getByRole("button", { name: "Сохранить", exact: true }).tap();
    await expect(panel.locator(".notebook-status")).toContainText("Сохранено");
    const note = book.list("codex:project", "Контекст", 0).items[0];
    assert(note);
    assert.equal(book.get(note.id).links[0].id, f.thread.id);
    await panel.getByRole("button", { name: "Просмотр", exact: true }).tap();
    await expect(panel.getByRole("heading", { name: "Решение" })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Копировать блок" })).toBeVisible();
    await panel.getByRole("button", { name: "Текст", exact: true }).tap();
    await body.fill("Мой вариант iPhone");
    book.save(note.id, { ...book.get(note.id), body: "Изменено с планшета" });
    await panel.getByRole("button", { name: "Сохранить", exact: true }).tap();
    await expect(panel.getByText("На сервере есть другая версия.")).toBeVisible();
    await expect(body).toHaveValue("Мой вариант iPhone");
    assert.equal(book.get(note.id).body, "Изменено с планшета");
    await panel.getByText("Посмотреть версию с другого устройства").click();
    await expect(panel.locator(".notebook-conflict pre")).toBeVisible();
    await panel.getByRole("button", { name: "Сохранить мой вариант", exact: true }).tap();
    await expect(panel.getByText("На сервере есть другая версия.")).toHaveCount(0);
    assert.equal(book.get(note.id).body, "Мой вариант iPhone");
    await panel.getByRole("button", { name: "Закрепить заметку", exact: true }).tap();
    await expect(panel.locator(".notebook-status")).toContainText("Ссылка сохранена");
    await panel.getByRole("button", { name: "К списку заметок" }).tap();
    await expect(
      panel
        .getByRole("region", { name: "Закреплённые", exact: true })
        .getByText("Контекст книжного проекта"),
    ).toBeVisible();
    await panel
      .getByRole("region", { name: "Закреплённые", exact: true })
      .getByRole("button", { name: "Контекст книжного проекта", exact: true })
      .click();
    await expect(body).toHaveValue("Мой вариант iPhone");
    // A lost save response leaves the exact draft and an explicit idempotent retry.
    await body.fill("Сохранено, ответ потерялся");
    let lose = true;
    await page.route(`**/api/workspace/notes/${note.id}`, async (route) => {
      if (lose && route.request().method() === "PUT") {
        lose = false;
        await route.fetch();
        await route.abort();
      } else await route.continue();
    });
    await panel.getByRole("button", { name: "Сохранить", exact: true }).click();
    await expect(panel.getByRole("alert")).toBeVisible();
    assert.equal(book.get(note.id).body, "Сохранено, ответ потерялся");
    await expect(body).toHaveValue("Сохранено, ответ потерялся");
    const rev = book.get(note.id).revision;
    await panel.getByRole("button", { name: "Сохранить", exact: true }).click();
    await expect(panel.locator(".notebook-status")).toContainText("Сохранено");
    assert.equal(book.get(note.id).revision, rev);
    await page.setViewportSize({ width: 844, height: 390 });
    await page.screenshot({ path: `.local/qa-notebook/${engine}-landscape.png` });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await panel.getByRole("button", { name: "Закрыть заметки" }).click();
    await page.setViewportSize({ width: 1366, height: 1024 });
    await page
      .getByRole("button", { name: "Настройки", exact: true })
      .filter({ visible: true })
      .first()
      .click();
    await page.locator(".theme-option.hitech-2000s input").check();
    await page.getByRole("button", { name: "Закрыть настройки", exact: true }).click();
    await open();
    await panel
      .getByRole("region", { name: "Закреплённые", exact: true })
      .getByRole("button", { name: "Контекст книжного проекта", exact: true })
      .click();
    await page.screenshot({ path: `.local/qa-notebook/${engine}-tablet.png` });
    await panel.getByRole("button", { name: "Удалить заметку", exact: true }).click();
    await expect(panel.getByText("Удалить заметку «Контекст книжного проекта»?")).toBeVisible();
    assert(book.get(note.id));
    await panel.getByRole("button", { name: "Удалить", exact: true }).click();
    await expect(panel.getByText("Источник недоступен", { exact: true })).toBeVisible();
    await panel.getByRole("button", { name: "Закрыть заметки" }).click();
    await page
      .getByRole("button", { name: "Переключиться на GPT" })
      .filter({ visible: true })
      .click();
    const gpt = page.getByRole("textbox", { name: "Сообщение GPT" });
    await expect(gpt).toBeVisible();
    await gpt.fill("Черновик GPT остаётся");
    await open();
    await expect(panel.getByRole("button", { name: "Все", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await panel.getByRole("button", { name: "Новая заметка" }).click();
    await title.fill("Общая заметка из GPT");
    await body.fill("Не трогаем нативный браузер");
    await panel.getByRole("button", { name: "Сохранить", exact: true }).click();
    await expect(panel.locator(".notebook-status")).toContainText("Сохранено");
    await panel.getByRole("button", { name: "Закрыть заметки" }).click();
    await expect(gpt).toHaveValue("Черновик GPT остаётся");
    await open();
    book.pin(
      null,
      { client: "codex", kind: "thread", id: f.thread.id, title: f.thread.title },
      true,
    );
    await panel.getByRole("button", { name: "Без проекта", exact: true }).click();
    await panel.getByRole("button", { name: "Все", exact: true }).click();
    await panel
      .getByRole("region", { name: "Закреплённые", exact: true })
      .getByRole("button", { name: "Handoff chat", exact: true })
      .click();
    await expect(chat).toHaveValue("Черновик чата сохранён");
    assert.equal(
      f.calls.filter((c) => ["thread/resume", "turn/start"].includes(c.method)).length,
      0,
    );
    assert.equal(f.desktopCalls.filter((c) => c !== "Status").length, 0);
    assert.deepEqual(errors, []);
    console.log(
      engine +
        ": scoped notebook, drafts, Markdown, conflict, lost acknowledgement retry, pins, deletion and Codex/GPT continuity passed",
    );
  } finally {
    await context.close();
    await browser.close();
    await f.close();
  }
}
