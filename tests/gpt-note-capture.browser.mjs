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
    mid = randomUUID(),
    secondId = randomUUID();
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
      contextReads = 0,
      delayed = false,
      releaseHistory,
      delayedStarted = false,
      secondFailed = false;
    const historyGate = new Promise((resolve) => (releaseHistory = resolve));
    page.on("pageerror", (e) => errors.push(e.message));
    const text = "Полезный ответ GPT\n\n  точные пробелы  ",
      message = { id: mid, role: "assistant", text, createdAt: Date.now() / 1000, files: [] };
    await page.route("**/api/gpt/**", async (route) => {
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
            items: [
              { id, title: "GPT source", updatedAt: Date.now() / 1000 },
              { id: secondId, title: "Second chat", updatedAt: Date.now() / 1000 },
            ],
            nextOffset: null,
          },
        });
      if (path.includes("/messages")) {
        if (path.includes(secondId) && !secondFailed) {
          secondFailed = true;
          return route.fulfill({
            status: 503,
            json: { error: { code: "GPT_TEST_TRANSIENT", message: "Связь временно потеряна" } },
          });
        }

        if (delayed && path.includes(id) && !url.searchParams.has("messageId")) {
          delayedStarted = true;
          await historyGate;
          return route.fulfill({
            status: 503,
            json: { error: { code: "GPT_TEST_OLD_HISTORY", message: "Ошибка прошлого чата" } },
          });
        }
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
      .getByRole("button", { name: "Переключиться на GPT" })
      .filter({ visible: true })
      .click();
    await page
      .getByRole("button", { name: "GPT source", exact: true })
      .filter({ visible: true })
      .click();
    const chat = page.getByRole("textbox", { name: "Сообщение GPT" });
    await expect(chat).toBeVisible();
    for (const width of [393, 1024, 1099, 1100, 1366]) {
      await page.setViewportSize({ width, height: width < 1100 ? 844 : 1024 });
      await expect(page.locator(".workspace-header .wide-pane-control")).toBeVisible({
        visible: width >= 1100,
      });
    }
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
    await page.setViewportSize({ width: 1366, height: 1024 });
    delayed = true;
    await page.getByRole("button", { name: "К последним сообщениям", exact: true }).click();
    await expect.poll(() => delayedStarted).toBe(true);
    await page.evaluate(
      (id) =>
        sessionStorage.setItem(
          "gpt-draft-" + id,
          JSON.stringify({ text: "Черновик второго чата", files: [] }),
        ),
      secondId,
    );
    await page
      .getByRole("button", { name: "Second chat", exact: true })
      .filter({ visible: true })
      .click();
    await expect(chat).not.toBeVisible();
    await expect(page.getByText("Связь временно потеряна", { exact: true })).toBeVisible();
    const lateResponse = page.waitForResponse((r) => r.status() === 503 && r.url().includes(id));
    releaseHistory();
    await lateResponse;
    await expect(page.getByText("Ошибка прошлого чата", { exact: true })).not.toBeVisible();
    await expect(page.getByText("Связь временно потеряна", { exact: true })).toBeVisible();
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect(page.getByText("Связь временно потеряна", { exact: true })).not.toBeVisible();
    await expect(chat).toHaveValue("Черновик второго чата");
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
