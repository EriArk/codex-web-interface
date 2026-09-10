import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, expect, webkit } from "@playwright/test";
import { Notebook } from "../apps/hub/dist/notebook.js";
import { handoffFixture } from "./handoff-fixture.mjs";

await mkdir(".local/qa-capture", { recursive: true });
for (const [engine, type] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
  const origin = "http://127.0.0.1:18858",
    f = await handoffFixture(origin),
    book = new Notebook(f.sessions);
  f.store.db.prepare("UPDATE threads SET origin='web' WHERE id=?").run(f.thread.id);
  for (let i = 0; i < 60; i++)
    f.store.append(
      f.thread.id,
      "assistant.completed",
      { id: "m" + i, text: "Ответ " + i + "\n  точный текст  ", phase: "final" },
      "turn" + i,
    );
  f.store.setPreferences({
    projectId: "project",
    threadId: f.thread.id,
    theme: "crt-green",
    view: "chat",
  });
  const browser = await type.launch(),
    context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      serviceWorkers: "block",
    });
  try {
    await f.app.listen({ port: 18858, host: "127.0.0.1" });
    const [name, value] = f.headers.cookie.split("=");
    await context.addCookies([{ name, value, url: origin, httpOnly: true, sameSite: "Strict" }]);
    const page = await context.newPage(),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(origin);
    const chat = page.getByRole("textbox", { name: "Сообщение Codex" });
    await expect(chat).toBeVisible();
    await chat.fill("Мой несохранённый вопрос");
    const capture = page
      .locator('[data-message="m59"]')
      .getByRole("button", { name: "Сохранить в заметки" });
    await capture.click();
    const panel = page.getByRole("dialog", { name: "Сохранить в заметки", exact: true });
    await expect(panel).toBeVisible();
    await expect(panel.locator("blockquote")).toHaveText("Ответ 59\n  точный текст  ");
    await panel.getByRole("combobox", { name: "Проект заметки" }).selectOption("global");
    let lose = true;
    await page.route("**/api/workspace/notes/*/capture", async (route) => {
      if (lose) {
        lose = false;
        await route.fetch();
        await route.abort();
      } else await route.continue();
    });
    await panel.getByRole("button", { name: "Сохранить", exact: true }).click();
    await expect(panel.getByRole("alert")).toBeVisible();
    assert.equal(book.list("all", "", 0).items.length, 1);
    await panel.getByRole("button", { name: "Сохранить", exact: true }).click();
    await expect(panel).not.toBeVisible();
    await expect(chat).toHaveValue("Мой несохранённый вопрос");
    assert.equal(book.list("all", "", 0).items.length, 1);
    const note = book.get(book.list("all", "", 0).items[0].id);
    assert.equal(note.source.target.messageId, "m59");
    await page.getByRole("button", { name: "Открыть проекты" }).click();
    await page
      .getByRole("button", { name: "Заметки и ссылки", exact: true })
      .filter({ visible: true })
      .click();
    const notes = page.getByRole("dialog", { name: "Заметки и ссылки", exact: true });
    await notes.getByRole("button", { name: /Ответ 59/ }).click();
    await notes.locator(".note-source-card summary").click();
    for (const theme of ["crt-green", "hitech-2000s", "organizer", "classic-dark"]) {
      await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
      await page.screenshot({ path: `.local/qa-capture/${engine}-${theme}.png` });
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
    await notes.getByRole("button", { name: "Открыть источник", exact: true }).click();
    await expect(notes).not.toBeVisible();
    await expect(chat).toHaveValue("Мой несохранённый вопрос");
    await expect(page.locator('[data-message="m59"]')).toHaveClass(/message-focus/);
    assert.equal(
      f.calls.filter((c) => ["turn/start", "thread/resume"].includes(c.method)).length,
      0,
    );
    assert.deepEqual(errors, []);
    console.log(
      engine +
        ": direct capture, frozen source, lost ack retry, exact backlink, four themes and draft preservation passed",
    );
  } finally {
    await context.close();
    await browser.close();
    await f.close();
  }
}
