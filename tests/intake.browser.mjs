import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { chromium, expect, webkit } from "@playwright/test";
import { handoffFixture } from "./handoff-fixture.mjs";

const engine = process.env.BROWSER ?? "chromium",
  origin = "http://127.0.0.1:18876";
const projectName = "AltarAppsReborn — совместимость сохранений";
const f = await handoffFixture(origin, undefined, {
  configure(config) {
    config.projects[0].name = projectName;
  },
});
await f.release();
const original = f.rpc.request.bind(f.rpc);
f.rpc.request = async (method, params) => {
  if (method === "thread/start") {
    f.calls.push({ method, params });
    return { thread: { id: randomUUID(), historyMode: "paginated" } };
  }
  return original(method, params);
};
f.sessions.catalog.history = async (t) => ({ ...f.store.history(t.id), nextBefore: null });
f.intake.inspect = async () => ({ remote: { url: "https://github.com/owner/repo.git" } });
f.intake.probe = async (_m, _p, q) => ({
  access: "write",
  repository: "owner/repo",
  repositoryId: 42,
  identity: { id: 7, login: "me" },
  query: q.query,
  ...(q.query.kind === "evidence"
    ? { evidence: { source: q.query.source, text: "Exact source text", truncated: false } }
    : {
        record: {
          type: "issue",
          number: 42,
          title: "Issue from repository",
          body: "Exact issue body",
          author: { id: 7, login: "me" },
          state: "open",
          url: "https://github.com/owner/repo/issues/42",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          comments: 0,
          labels: [],
          assignees: [],
        },
        commentsPage: [],
        nextPage: null,
      }),
});
f.store.setPreferences({
  projectId: "project",
  threadId: f.thread.id,
  theme: "classic-dark",
  view: "chat",
});
const browser = await (engine === "webkit" ? webkit : chromium).launch(),
  context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    serviceWorkers: "block",
  });
await mkdir(".local/qa-intake", { recursive: true });
try {
  await f.app.listen({ port: 18876, host: "127.0.0.1" });
  const [name, value] = f.headers.cookie.split("=");
  await context.addCookies([{ name, value, url: origin, httpOnly: true, sameSite: "Strict" }]);
  const page = await context.newPage(),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(origin);
  const main = page.getByRole("textbox", { name: "Сообщение Codex" });
  await expect(main).toBeVisible();
  await main.fill("Рабочий черновик не менять");
  await page.getByRole("button", { name: "Обзор текущего проекта" }).click();
  await page.getByRole("button", { name: "Разобрать входящие задачи" }).click();
  const dialog = page.getByRole("dialog", { name: "Разбор · " + projectName });
  await expect(dialog).toBeVisible();
  await page.screenshot({ path: `.local/qa-intake/${engine}-empty-phone.png` });
  await dialog.locator("summary").filter({ hasText: "Issues, PR" }).click();
  await dialog
    .getByRole("textbox", { name: "Источники разбора" })
    .fill("https://github.com/owner/repo/issues/42");
  await dialog
    .getByRole("textbox", { name: "Сообщение для разбора" })
    .fill("Изучи задачу, найди риски");
  await dialog.getByRole("button", { name: "Закрыть разбор" }).click();
  await page.getByRole("button", { name: "Разобрать входящие задачи" }).click();
  await expect(dialog.getByRole("textbox", { name: "Сообщение для разбора" })).toHaveValue(
    "Изучи задачу, найди риски",
  );
  await dialog.getByRole("button", { name: "Отправить на разбор" }).click();
  await expect.poll(() => f.calls.filter((c) => c.method === "turn/start").length).toBe(1);
  assert.equal(
    f.projectWork.context.current({ client: "codex", projectId: "project", name: "" }).threadId,
    f.thread.id,
  );
  const state = f.intake.get("project"),
    thread = f.store.thread(state.threadId),
    turnId = thread.activeTurnId;
  f.rpc.emit("notification", "item/completed", {
    threadId: thread.codexThreadId,
    turnId,
    item: {
      type: "agentMessage",
      id: "intake-final",
      phase: "final_answer",
      text:
        "## Интерпретация\n\nУстранить повторную загрузку.\n\n## План\n\n1. Проверить кэш.\n2. Сохранить состояние.\n\n## Риски и проверки\n\nПроверить потерю связи и возвращение в чат.\n\n```text\nКороткий пример\n```\n\n```text\n" +
        Array.from({ length: 21 }, (_, i) => "Строка " + (i + 1)).join("\n") +
        "\n```",
    },
  });
  f.rpc.emit("notification", "turn/completed", {
    threadId: thread.codexThreadId,
    turn: { id: turnId, status: "completed" },
  });
  await expect(dialog.getByRole("button", { name: "Подготовить к работе" })).toBeVisible({
    timeout: 10000,
  });
  await expect(dialog.locator(".message-short-block")).toContainText("Короткий пример");
  await dialog.getByRole("button", { name: "Блок в результатах · 21 строк" }).click();
  const results = page.getByRole("dialog", { name: "Результаты разбора", exact: true });
  await expect(results.locator(".result-inspector")).toContainText("Строка 21");
  await results.getByRole("button", { name: "Закрыть результаты разбора" }).click();
  await dialog
    .locator("summary")
    .filter({ hasText: /^Источники$/ })
    .click();
  await dialog.getByRole("button", { name: "Issue #42", exact: true }).click();
  const source = page.getByRole("dialog", { name: "GitHub · событие" });
  await expect(source.getByText("Exact issue body", { exact: true })).toBeVisible();
  assert.equal(context.pages().length, 1);
  await source.getByRole("button", { name: "Закрыть событие" }).click();
  await dialog.getByRole("button", { name: "Подготовить к работе" }).click();
  await dialog
    .getByRole("textbox", { name: "Пакет для работы" })
    .fill("Исправить кэш; проверить потерю связи и повторное открытие.");
  await dialog.getByRole("button", { name: "Закрыть разбор" }).click();
  await page.getByRole("button", { name: "Разобрать входящие задачи" }).click();
  await expect(dialog.getByRole("textbox", { name: "Пакет для работы" })).toHaveValue(
    "Исправить кэш; проверить потерю связи и повторное открытие.",
  );
  let lost = false;
  await page.route("**/api/projects/project/intake/handoff", async (route) => {
    if (!lost) {
      lost = true;
      await route.fetch();
      await route.abort();
    } else await route.continue();
  });
  await dialog.getByRole("button", { name: "Проверить передачу" }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await dialog.getByRole("button", { name: "Проверить передачу" }).click();
  const action = dialog.getByRole("region", { name: "Задание проекта" });
  await expect(action.getByText("Готово к запуску", { exact: true })).toBeVisible();
  assert.equal(f.calls.filter((c) => c.method === "turn/start").length, 1);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM project_plans").get().n, 1);
  await action.getByRole("button", { name: "Подтвердить и запустить" }).click();
  await expect(action.getByText("В работе", { exact: true })).toBeVisible();
  assert.equal(f.calls.filter((c) => c.method === "turn/start").length, 2);
  for (const theme of ["classic-dark", "organizer", "crt-green", "hitech-2000s"]) {
    await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    for (const size of [
      { width: 390, height: 844 },
      { width: 390, height: 500 },
      { width: 768, height: 1024 },
      { width: 1366, height: 1024 },
    ]) {
      await page.setViewportSize(size);
      await expect(dialog.getByRole("textbox", { name: "Сообщение для разбора" })).toBeVisible();
      await expect
        .poll(
          async () => {
            const box = await dialog.boundingBox();
            return (
              box.x >= -1 &&
              box.y >= -1 &&
              box.x + box.width <= size.width + 1 &&
              box.y + box.height <= size.height + 1
            );
          },
          { message: JSON.stringify({ theme, size }) },
        )
        .toBe(true);
      assert(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1));
      assert(
        await dialog.evaluate((el) => {
          const r = el.getBoundingClientRect(),
            h = el.querySelector("header").getBoundingClientRect();
          const title = el.querySelector("h2").getBoundingClientRect();
          const buttons = [...el.querySelectorAll(":scope > header > button")].map((b) =>
            b.getBoundingClientRect(),
          );
          return (
            Math.abs(r.left - (innerWidth - r.right)) < 2 &&
            h.height < 110 &&
            buttons.every(
              (b) => b.width >= 44 && b.height >= 44 && b.left >= title.right && b.right <= r.right,
            )
          );
        }),
        "centered dialog and uncrowded header with reachable controls",
      );
      await page.screenshot({
        path: `.local/qa-intake/${engine}-${theme}-${size.width}x${size.height}.png`,
      });
    }
  }
  await dialog.getByRole("button", { name: "Закрыть разбор" }).click();
  await expect(main).toHaveValue("Рабочий черновик не менять");
  assert.deepEqual(errors, []);
  console.log(
    engine +
      ": Intake native fixture/read-only flow, internal source, preserved drafts, lost handoff ACK, explicit one Work send and four-theme geometry passed.",
  );
} finally {
  await context.close();
  await browser.close();
  await f.close();
}
