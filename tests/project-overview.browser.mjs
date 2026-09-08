import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { chromium, expect, webkit } from "@playwright/test";
import { ProjectHome } from "../apps/hub/dist/overview.js";
import { handoffFixture } from "./handoff-fixture.mjs";

await mkdir(".local/qa-overview", { recursive: true });
for (const [engine, type] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
  const origin = "http://127.0.0.1:18857",
    f = await handoffFixture(origin),
    home = new ProjectHome(f.sessions),
    scope = { client: "codex", projectId: "project", name: "Project" };
  f.store.setPreferences({
    projectId: "project",
    threadId: f.thread.id,
    theme: "crt-green",
    view: "chat",
  });
  f.store.db
    .prepare("UPDATE threads SET origin='web',status='running' WHERE id=?")
    .run(f.thread.id);
  const unread = f.store.createThread("project", "native-unread", "Готовая проверка");
  f.store.db.prepare("UPDATE threads SET completedSeq=7,seenSeq=0 WHERE id=?").run(unread.id);
  f.sessions.config.projects.push({
    id: "empty",
    name: "Empty",
    machineId: "pc",
    workingDirectory: "C:/Empty",
    enabled: true,
  });
  const note = home.notes.save(randomUUID(), {
      scope,
      title: "Решение проекта",
      body: "Сохранённый контекст",
      revision: 0,
      links: [],
    }),
    task = home.tasks.save(randomUUID(), {
      scope,
      title: "Следующий шаг",
      body: "Проверить сохранение",
      revision: 0,
      links: [],
      status: "blocked",
      priority: 2,
      dueAt: null,
    });
  home.notes.pin(scope, { client: "codex", kind: "note", id: note.id, title: note.title }, true);
  const result = f.store.result(unread.id, null, "overview-result", "check", "Проверка завершена", {
    text: "Полезный результат",
  });
  const browser = await type.launch(),
    context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      serviceWorkers: "block",
    });
  try {
    await f.app.listen({ port: 18857, host: "127.0.0.1" });
    const [name, value] = f.headers.cookie.split("=");
    await context.addCookies([{ name, value, url: origin, httpOnly: true, sameSite: "Strict" }]);
    const page = await context.newPage(),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    let overviewReads = 0,
      statusReads = 0,
      seenWrites = 0;
    page.on("request", (r) => {
      if (r.url().includes("/workspace/overview?")) overviewReads++;
      if (r.url().includes("/projects/project/status")) statusReads++;
      if (r.url().includes(`/threads/${unread.id}/seen`)) seenWrites++;
    });
    await page.goto(origin);
    const chat = page.getByRole("textbox", { name: "Сообщение Codex" });
    await expect(chat).toBeVisible();
    await chat.fill("Черновик остаётся в чате");
    const open = () => page.getByRole("button", { name: "Обзор текущего проекта" }).click();
    const before = statusReads;
    await open();
    const panel = page.getByRole("region", { name: "Обзор проекта Project", exact: true });
    await expect(panel.getByRole("button", { name: /Следующий шаг/ })).toBeVisible();
    assert.equal(overviewReads, 1);
    assert.equal(statusReads, before);
    assert.equal(seenWrites, 0);
    assert.equal(f.store.thread(unread.id).seenSeq, 0);
    await expect(chat).not.toBeVisible();
    await page.screenshot({ path: `.local/qa-overview/${engine}-phone.png` });
    await panel.getByRole("button", { name: "Решение проекта", exact: true }).click();
    const notes = page.getByRole("dialog", { name: "Заметки и ссылки", exact: true });
    await expect(notes.getByRole("textbox", { name: "Текст заметки" })).toHaveValue(
      "Сохранённый контекст",
    );
    await notes.getByRole("button", { name: "Закрыть заметки" }).click();
    await panel.getByRole("button", { name: /Следующий шаг/ }).click();
    const plan = page.getByRole("dialog", { name: "План", exact: true });
    await expect(plan.getByRole("textbox", { name: "Название задачи" })).toHaveValue(task.title);
    await plan.getByRole("button", { name: "Закрыть план" }).click();
    await panel.getByRole("button", { name: /^Handoff chat/ }).click();
    await expect(chat).toHaveValue("Черновик остаётся в чате");
    await open();
    await panel.getByRole("button", { name: "Проверка завершена", exact: true }).click();
    await expect(page.locator(`[data-result="${result}"]`)).toBeVisible();
    assert.equal(seenWrites, 0);
    await page.setViewportSize({ width: 1366, height: 1024 });
    await open();
    for (const theme of ["organizer", "hitech-2000s", "classic-dark"]) {
      await page
        .getByRole("button", { name: "Настройки", exact: true })
        .filter({ visible: true })
        .first()
        .click();
      await page.locator(`.theme-option.${theme} input`).check();
      await page.getByRole("button", { name: "Закрыть настройки", exact: true }).click();
      await page.screenshot({ path: `.local/qa-overview/${engine}-tablet-${theme}.png` });
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
    await page.locator('.nav-project[data-project-id="empty"]').filter({ visible: true }).click();
    await page
      .locator(".nav-project-group")
      .filter({ has: page.locator('[data-project-id="empty"]') })
      .filter({ visible: true })
      .getByRole("button", { name: "Обзор проекта", exact: true })
      .click();
    const empty = page.getByRole("region", { name: "Обзор проекта Empty", exact: true });
    await expect(empty.getByText("Пока нет диалогов.")).toBeVisible();
    await expect(empty.getByRole("button", { name: "Новый диалог", exact: true })).toBeEnabled();
    await page.reload();
    await expect(empty.getByText("Пока нет диалогов.")).toBeVisible();
    assert.equal(f.store.preferences().threadId, null);
    // GPT Home uses normalized catalog data already present in the client, and only Hub-owned context.
    const gptId = randomUUID();
    await page.route("**/api/gpt/conversations?*", (r) =>
      r.fulfill({
        json: {
          items: [
            {
              id: gptId,
              title: "GPT проектный чат",
              projectId: "g-project",
              updatedAt: Date.now() / 1000,
            },
          ],
          nextOffset: null,
        },
      }),
    );
    await page.route("**/api/gpt/projects", (r) =>
      r.fulfill({
        json: {
          items: [{ id: "g-project", name: "GPT Project" }],
          conversations: [
            {
              id: gptId,
              title: "GPT проектный чат",
              projectId: "g-project",
              updatedAt: Date.now() / 1000,
            },
          ],
        },
      }),
    );
    await page.route(`**/api/gpt/conversations/${gptId}/messages?*`, (r) =>
      r.fulfill({
        json: {
          items: [],
          nextBefore: null,
          revision: "test",
          prefix: "",
          retainOlder: true,
          notModified: false,
        },
      }),
    );
    home.tasks.save(randomUUID(), {
      scope: { client: "gpt", projectId: "g-project", name: "GPT Project" },
      title: "GPT follow-up",
      body: "Owner context",
      revision: 0,
      links: [],
      status: "todo",
      priority: 1,
      dueAt: null,
    });
    home.notes.pin(
      { client: "gpt", projectId: "g-project", name: "GPT Project" },
      { client: "codex", kind: "thread", id: f.thread.id, title: f.thread.title },
      true,
    );
    await page
      .getByRole("combobox", { name: "Режим приложения" })
      .filter({ visible: true })
      .selectOption("gpt");
    const gpt = page.getByRole("textbox", { name: "Сообщение GPT" });
    await expect(gpt).toBeVisible();
    await gpt.fill("Черновик GPT");
    await page.getByRole("button", { name: "GPT Project", exact: true }).click();
    await page
      .getByRole("button", { name: "Обзор проекта", exact: true })
      .filter({ visible: true })
      .click();
    const gptHome = page.getByRole("region", { name: "Обзор проекта GPT Project", exact: true });
    await expect(gptHome.getByRole("button", { name: /GPT follow-up/ })).toBeVisible();
    await expect(
      gptHome.getByRole("button", { name: "GPT проектный чат", exact: true }),
    ).toBeVisible();
    await expect(gpt).not.toBeVisible();
    await gptHome.getByRole("button", { name: "GPT проектный чат", exact: true }).click();
    await expect(gpt).toBeVisible();
    await page
      .getByRole("button", { name: "Обзор проекта", exact: true })
      .filter({ visible: true })
      .click();
    await gptHome.getByRole("button", { name: "Handoff chat", exact: true }).click();
    await expect(chat).toHaveValue("Черновик остаётся в чате");
    assert.deepEqual(errors, []);
    assert.equal(
      f.calls.filter((c) => ["thread/resume", "turn/start"].includes(c.method)).length,
      0,
    );
    assert.equal(f.desktopCalls.filter((c) => c !== "Status").length, 0);
    console.log(
      engine +
        ": real project summaries, unread preservation, note/task/Result/thread links, empty project, themes and cached GPT overview passed",
    );
  } finally {
    await context.close();
    await browser.close();
    await f.close();
  }
}
