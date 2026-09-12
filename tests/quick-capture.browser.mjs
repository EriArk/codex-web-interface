import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { chromium, expect, webkit } from "@playwright/test";
import { handoffFixture } from "./handoff-fixture.mjs";

for (const [engine, type] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
  const origin = "http://127.0.0.1:18876",
    f = await handoffFixture(origin),
    gptId = randomUUID();
  f.store.setPreferences({ projectId: "project", threadId: f.thread.id, theme: "classic-dark" });
  const browser = await type.launch(),
    context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      serviceWorkers: "block",
    });
  const [name, value] = f.headers.cookie.split("=");
  await context.addCookies([{ name, value, url: origin, httpOnly: true, sameSite: "Strict" }]);
  const page = await context.newPage(),
    errors = [],
    out = `.local/qa-capture/${engine}`;
  await mkdir(out, { recursive: true });
  page.on("pageerror", (e) => errors.push(e.message));
  let sends = 0,
    lost = false;
  try {
    await f.app.listen({ host: "127.0.0.1", port: 18876 });
    await page.route("**/api/gpt/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/send")) sends++;
      const data = path.endsWith("/status")
        ? { configured: true, canSend: true, state: "healthy" }
        : path.endsWith("/models")
          ? { models: [], efforts: [] }
          : path.endsWith("/projects")
            ? {
                items: [{ id: "gpt-project", name: "GPT Project" }],
                conversations: [],
                nextOffset: null,
              }
            : path.endsWith("/conversations")
              ? {
                  items: [
                    {
                      id: gptId,
                      title: "GPT capture chat",
                      projectId: "gpt-project",
                      updatedAt: Date.now() / 1000,
                    },
                  ],
                  nextOffset: null,
                }
              : path.includes("/messages")
                ? { items: [], nextBefore: null, revision: "fixture", retainOlder: true }
                : { items: [], jobs: [], nextOffset: null };
      return route.fulfill({ json: data });
    });
    await page.goto(origin);
    const chat = page.getByRole("textbox", { name: "Сообщение Codex" });
    await chat.fill("Не терять основной черновик");
    await page.getByRole("button", { name: "Открыть проекты", exact: true }).click();
    const open = () =>
      page
        .getByRole("button", { name: "Быстрая запись", exact: true })
        .filter({ visible: true })
        .click();
    await open();
    const panel = page.getByRole("dialog", { name: "Быстрая запись", exact: true });
    await expect(panel.getByRole("combobox", { name: "Проект записи" })).toHaveValue(
      "codex:project",
    );
    await panel.getByRole("textbox", { name: "Текст записи" }).fill("Мысль\n\n  точные пробелы  ");
    await panel.getByRole("button", { name: "Закрыть запись" }).click();
    await open();
    await expect(panel.getByRole("textbox", { name: "Текст записи" })).toHaveValue(
      "Мысль\n\n  точные пробелы  ",
    );
    await page.route("**/api/workspace/captures/*", async (route) => {
      if (!lost) {
        lost = true;
        await route.fetch();
        await route.abort("failed");
      } else await route.continue();
    });
    await panel.getByRole("button", { name: "Сохранить", exact: true }).click();
    await expect(panel.getByRole("alert")).toBeVisible();
    await panel.getByRole("button", { name: "Закрыть запись" }).click();
    await open();
    await expect(panel.getByRole("textbox", { name: "Текст записи" })).toBeDisabled();
    await panel.getByRole("button", { name: "Проверить сохранение", exact: true }).click();
    await expect(panel.getByRole("heading", { name: "Сохранено", exact: true })).toBeVisible();
    assert.equal(f.store.db.prepare("SELECT count(*) n FROM workspace_notes").get().n, 1);
    await panel.getByRole("button", { name: "Готово", exact: true }).click();
    await page
      .getByRole("button", { name: "Переключиться на GPT" })
      .filter({ visible: true })
      .click();
    await page.getByRole("button", { name: "Открыть проекты", exact: true }).click();
    await page
      .getByRole("button", { name: "GPT Project", exact: true })
      .filter({ visible: true })
      .click();
    await page
      .getByRole("button", { name: "GPT capture chat", exact: true })
      .filter({ visible: true })
      .click();
    const gpt = page.getByRole("textbox", { name: "Сообщение GPT" });
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await gpt.fill("Черновик GPT");
    await expect(gpt).toHaveValue("Черновик GPT");
    await expect
      .poll(() =>
        page.evaluate(
          (id) => JSON.parse(sessionStorage.getItem("gpt-draft-" + id) ?? "{}").text,
          gptId,
        ),
      )
      .toBe("Черновик GPT");
    await page.getByRole("button", { name: "Открыть проекты", exact: true }).click();
    await open();
    await expect(panel.getByRole("combobox", { name: "Проект записи" })).toHaveValue(
      "gpt:gpt-project",
    );
    await panel.getByRole("button", { name: "Задача", exact: true }).click();
    await panel.getByRole("combobox", { name: "Проект записи" }).selectOption("global");
    await panel.getByRole("textbox", { name: "Текст записи" }).fill("Проверить планшет");
    await panel.getByText("Приоритет и срок", { exact: true }).click();
    await panel.getByRole("combobox", { name: "Приоритет записи" }).selectOption("2");
    assert.equal(
      await gpt.inputValue(),
      "Черновик GPT",
      "capture kept GPT draft before layout changes",
    );
    for (const theme of ["classic-dark", "organizer", "crt-green", "hitech-2000s"]) {
      await page.evaluate((t) => {
        document.documentElement.dataset.theme = t;
        document.documentElement.dataset.caseColor = "red";
      }, theme);
      for (const width of [390, 1366]) {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 1024 });
        assert(await panel.evaluate((e) => e.scrollWidth <= e.clientWidth));
        for (const kind of ["Заметка", "Задача"]) {
          await panel.getByRole("button", { name: kind, exact: true }).click();
          await page.screenshot({ path: `${out}/${theme}-${width}-${kind}.png` });
        }
      }
    }
    await page.setViewportSize({ width: 390, height: 430 });
    await panel.getByRole("button", { name: "Сохранить", exact: true }).click();
    await expect(panel.getByRole("heading", { name: "Сохранено", exact: true })).toBeVisible();
    const task = f.store.db.prepare("SELECT scope,status,priority FROM workspace_tasks").get();
    assert.equal(task.scope, null);
    assert.equal(task.status, "todo");
    assert.equal(task.priority, 2);
    await panel.getByRole("button", { name: "Готово", exact: true }).click();
    await page
      .getByRole("button", { name: "Закрыть проекты", exact: true })
      .filter({ visible: true })
      .click();
    await expect(gpt).toHaveValue("Черновик GPT");
    await page.getByRole("button", { name: "Открыть проекты", exact: true }).click();
    await page
      .getByRole("button", { name: "Переключиться на Codex" })
      .filter({ visible: true })
      .click();
    await expect(chat).toHaveValue("Не терять основной черновик");
    assert.equal(sends, 0);
    assert.equal(f.calls.filter((c) => c.method === "turn/start").length, 0);
    assert.deepEqual(errors, []);
    console.log(
      engine +
        ": note/task, project defaults, close/reopen, lost acknowledgement and both chat drafts passed",
    );
  } catch (e) {
    console.error(errors);
    console.error((await page.locator("body").innerText()).slice(-10000));
    await page.screenshot({ path: `${out}/failure.png` });
    throw e;
  } finally {
    await context.close();
    await browser.close();
    await f.close();
  }
}
