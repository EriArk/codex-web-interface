import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chromium, expect, webkit } from "@playwright/test";
import { Notebook } from "../apps/hub/dist/notebook.js";
import { handoffFixture } from "./handoff-fixture.mjs";

for (const [engine, type] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
  const origin = "http://127.0.0.1:18862",
    f = await handoffFixture(origin),
    book = new Notebook(f.sessions),
    id = randomUUID(),
    mid = randomUUID();
  const browser = await type.launch(),
    context = await browser.newContext({
      viewport: { width: 1366, height: 1024 },
      hasTouch: true,
      serviceWorkers: "block",
    });
  try {
    await f.app.listen({ port: 18862, host: "127.0.0.1" });
    const [name, value] = f.headers.cookie.split("=");
    await context.addCookies([{ name, value, url: origin, httpOnly: true, sameSite: "Strict" }]);
    const page = await context.newPage(),
      errors = [];
    let sends = 0,
      contextReads = 0;
    page.on("pageerror", (e) => errors.push(e.message));
    const text = "Полезный ответ GPT\n\n  точные пробелы  ",
      message = { id: mid, role: "assistant", text, createdAt: Date.now() / 1000, files: [] };
    await page.route("**/api/gpt/**", (route) => {
      const url = new URL(route.request().url()),
        path = url.pathname;
      if (path === "/api/gpt/send") {
        sends++;
        return route.fulfill({ status: 500, json: {} });
      }
      if (path === "/api/gpt/status")
        return route.fulfill({
          json: {
            configured: true,
            state: "healthy",
            canSend: true,
            activeJobs: 0,
            unknownJobs: 0,
          },
        });
      if (path === "/api/gpt/models")
        return route.fulfill({
          json: {
            models: [{ id: "Latest", label: "Latest" }],
            efforts: [{ id: "2", label: "High" }],
            currentModel: "Latest",
            currentEffort: "2",
          },
        });
      if (path === "/api/gpt/conversations")
        return route.fulfill({
          json: {
            items: [{ id, title: "GPT source", updatedAt: Date.now() / 1000 }],
            nextOffset: null,
          },
        });
      if (path.includes("/messages")) {
        if (url.searchParams.has("messageId")) contextReads++;
        return route.fulfill({
          json: {
            items: [message],
            nextBefore: null,
            revision: "fixture",
            prefix: "",
            retainOlder: true,
            notModified: false,
            ...(url.searchParams.has("messageId") ? { contextMessage: mid, hasNewer: true } : {}),
          },
        });
      }
      return route.fulfill({
        json: { items: [], jobs: [], conversations: [], nextOffset: null, after: 0 },
      });
    });
    await page.goto(origin);
    await page
      .getByRole("combobox", { name: "Режим приложения" })
      .filter({ visible: true })
      .selectOption("gpt");
    await page
      .getByRole("button", { name: "GPT source", exact: true })
      .filter({ visible: true })
      .click();
    const chat = page.getByRole("textbox", { name: "Сообщение GPT" });
    await expect(chat).toBeVisible();
    await chat.fill("Не отправлять черновик");
    await page.setViewportSize({ width: 390, height: 844 });
    await page
      .locator(`[data-message="${mid}"]`)
      .getByRole("button", { name: "Сохранить в заметки" })
      .click();
    const capture = page.getByRole("dialog", { name: "Сохранить в заметки", exact: true });
    await capture.getByRole("button", { name: "Сохранить", exact: true }).click();
    await expect(capture).not.toBeVisible();
    const note = book.get(book.list("all", "", 0).items[0].id);
    assert.equal(note.body, text);
    assert.equal(note.source.target.messageId, mid);
    assert.equal(note.source.target.threadId, id);
    await page.getByRole("button", { name: "Открыть проекты", exact: true }).click();
    await page
      .getByRole("navigation", { name: "Рабочие разделы" })
      .filter({ visible: true })
      .getByRole("button", { name: "Заметки", exact: true })
      .click();
    const notes = page.getByRole("dialog", { name: "Заметки и ссылки", exact: true });
    await notes.getByRole("button", { name: /Полезный ответ GPT/ }).click();
    await notes.locator(".note-source-card summary").click();
    await notes.getByRole("button", { name: "Открыть источник", exact: true }).click();
    await expect(chat).toHaveValue("Не отправлять черновик");
    await expect(page.locator(`[data-message="${mid}"]`)).toHaveClass(/message-focus/);
    assert(contextReads > 0);
    assert.equal(sends, 0);
    assert.deepEqual(errors, []);
    console.log(
      engine + ": real GPT UI capture, exact snapshot/source context and draft preservation passed",
    );
  } finally {
    await context.close();
    await browser.close();
    await f.close();
  }
}
