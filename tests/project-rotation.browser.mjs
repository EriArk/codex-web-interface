import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { chromium, expect, webkit } from "@playwright/test";
import { handoffFixture } from "./handoff-fixture.mjs";

await mkdir(".local/qa-rotation", { recursive: true });
for (const [engine, type] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
  const origin = "http://127.0.0.1:18861",
    f = await handoffFixture(origin);
  await f.release();
  const base = f.rpc.request.bind(f.rpc);
  f.rpc.request = async (m, p) => {
    if (m === "thread/start") {
      f.calls.push({ method: m, params: p });
      return { thread: { id: randomUUID(), historyMode: "paginated" } };
    }
    return base(m, p);
  };
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
    await f.app.listen({ port: 18861, host: "127.0.0.1" });
    const [name, value] = f.headers.cookie.split("=");
    await context.addCookies([{ name, value, url: origin, httpOnly: true, sameSite: "Strict" }]);
    const page = await context.newPage(),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(origin);
    const chat = page.getByRole("textbox", { name: "Сообщение Codex" });
    await expect(chat).toBeVisible();
    await chat.fill("Черновик старого чата");
    await page.getByRole("button", { name: "Обзор текущего проекта" }).click();
    await page.getByRole("button", { name: "Продолжить в новом чате" }).click();
    const panel = page.getByRole("dialog", { name: "Новый рабочий чат", exact: true });
    await expect(panel.getByText("Готово к запуску", { exact: true })).toBeVisible();
    assert.equal(f.calls.filter((c) => c.method === "thread/start").length, 0);
    await panel.getByText("Текст задания", { exact: true }).click();
    await expect(panel.getByText(/Владелец пока не заполнил основу/)).toBeVisible();
    await page.screenshot({ path: `.local/qa-rotation/${engine}-review-phone.png` });
    await panel.getByRole("button", { name: "Подтвердить и запустить" }).click();
    await expect(panel.getByText("В работе", { exact: true })).toBeVisible();
    assert.equal(f.calls.filter((c) => c.method === "thread/start").length, 1);
    assert.equal(f.calls.filter((c) => c.method === "turn/start").length, 1);
    const current = f.store.db.prepare("SELECT threadId FROM project_current_chats").get().threadId;
    assert.notEqual(current, f.thread.id);
    await panel.getByRole("button", { name: "Закрыть переход" }).click();
    const overview = page.getByRole("region", { name: "Продолжить работу" });
    await expect(overview.getByText("Текущий чат", { exact: true })).toBeVisible();
    await overview.getByText("Предыдущие чаты · 1", { exact: true }).click();
    await overview.locator(`button[data-thread-id="${f.thread.id}"]`).click();
    await expect(chat).toHaveValue("Черновик старого чата");
    await page.getByRole("button", { name: "Обзор текущего проекта" }).click();
    await page.setViewportSize({ width: 1366, height: 1024 });
    await page.screenshot({ path: `.local/qa-rotation/${engine}-overview-tablet.png` });
    assert.deepEqual(errors, []);
    console.log(
      engine +
        ": reviewed rotation, one native bootstrap, explicit Current/history and old draft passed",
    );
  } finally {
    await context.close();
    await browser.close();
    await f.close();
  }
}
