import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { chromium, expect, webkit } from "@playwright/test";
import { settings } from "./handoff-fixture.mjs";
import { issueFixture } from "./issue-drawer-fixture.mjs";

const origin = "http://127.0.0.1:18878",
  engine = process.env.BROWSER ?? "webkit",
  f = await issueFixture(origin);
const rpc = f.rpc.request.bind(f.rpc);
f.rpc.request = async (m, p) =>
  m === "thread/start" ? { thread: { id: randomUUID(), historyMode: "paginated" } } : rpc(m, p);
f.sessions.catalog.history = async (t) => ({ ...f.store.history(t.id), nextBefore: null });
const intake = await f.intake.send("project", randomUUID(), {
    text: "Подготовь Issue",
    revision: 0,
    sources: [],
    settings,
  }),
  thread = f.store.thread(intake.threadId),
  turnId = thread.activeTurnId;
const text =
  "Готовый блок для выбранной задачи.\n\n```md\n## Сохранить картинки\n\nНе перегружать изображения при обновлении.\n```\n";
f.sessions.emitEvent(
  thread.id,
  "assistant.completed",
  { id: "final-issue", text, phase: "final_answer" },
  turnId,
);
f.rpc.emit("notification", "turn/completed", {
  threadId: thread.codexThreadId,
  turn: { id: turnId, status: "completed" },
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
await mkdir(".local/qa-issues", { recursive: true });
try {
  await f.app.listen({ port: 18878, host: "127.0.0.1" });
  const [name, value] = f.headers.cookie.split("=");
  await context.addCookies([{ name, value, url: origin, httpOnly: true, sameSite: "Strict" }]);
  const page = await context.newPage(),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(origin);
  const composer = page.getByRole("textbox", { name: "Сообщение Codex" });
  await expect(composer).toBeVisible();
  await composer.fill("Не потерять черновик");
  await page.getByRole("button", { name: "Обзор текущего проекта" }).click();
  await page.getByRole("button", { name: "Разобрать входящие задачи" }).click();
  const intakeDialog = page.getByRole("dialog", { name: "Разбор · Project" });
  await expect(intakeDialog.getByText("Готовый блок для выбранной задачи.")).toBeVisible();
  await intakeDialog
    .locator(".message-short-block")
    .getByRole("button", { name: "В Issues", exact: true })
    .click();
  const drawer = page.getByRole("dialog", { name: "Подборка Issues", exact: true });
  await expect(drawer).toBeVisible();
  await drawer.getByRole("button", { name: "Добавить в подборку" }).click();
  const body = drawer.getByRole("textbox", { name: "Текст Issue", exact: true });
  await expect(body).toHaveValue(
    "## Сохранить картинки\n\nНе перегружать изображения при обновлении.\n",
  );
  await drawer
    .getByRole("textbox", { name: "Название Issue", exact: true })
    .fill("Картинки без мигания");
  await body.fill("Точный отредактированный текст\n\n- Проверить повторное открытие.");
  await drawer.getByRole("button", { name: "Закрыть подборку" }).click();
  await intakeDialog.getByRole("button", { name: "Подборка Issues", exact: true }).click();
  await drawer.getByRole("button", { name: "Изменить", exact: true }).click();
  await expect(body).toHaveValue(
    "Точный отредактированный текст\n\n- Проверить повторное открытие.",
  );
  await page.waitForTimeout(2800);
  await expect(body).toHaveValue(
    "Точный отредактированный текст\n\n- Проверить повторное открытие.",
  );
  for (const size of [
    { width: 390, height: 844 },
    { width: 390, height: 500 },
    { width: 768, height: 1024 },
    { width: 1366, height: 1024 },
  ]) {
    await page.setViewportSize(size);
    for (const theme of ["organizer", "crt-green", "hitech-2000s", "classic-dark"]) {
      await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
      const b = await drawer.evaluate((el) => {
        const r = el.getBoundingClientRect(),
          foot = el.querySelector("footer").getBoundingClientRect();
        return {
          left: r.left,
          right: r.right,
          top: r.top,
          bottom: r.bottom,
          foot: foot.bottom,
          overflow: el.scrollWidth > el.clientWidth + 1,
        };
      });
      assert(
        b.left >= -1 &&
          b.right <= size.width + 1 &&
          b.top >= -1 &&
          b.bottom <= size.height + 1 &&
          b.foot <= b.bottom + 1 &&
          !b.overflow,
        JSON.stringify({ size, theme, b }),
      );
      if (size.width === 390 && size.height === 844)
        await drawer.screenshot({ path: `.local/qa-issues/${engine}-${theme}.png` });
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await drawer.getByRole("button", { name: "Сохранить", exact: true }).click();
  await drawer.getByRole("checkbox", { name: "Выбрать: Картинки без мигания" }).check();
  await drawer.getByRole("button", { name: "Проверить пакет", exact: true }).click();
  await expect(
    drawer.getByText("От GitHub: @actual-user · Issues: 1", { exact: true }),
  ).toBeVisible();
  assert(!f.operations.some((q) => q.op === "apply"));
  await drawer.getByRole("button", { name: "Отправить 1 Issues", exact: true }).click();
  await expect(drawer.getByRole("button", { name: "Открыть Issue #1", exact: true })).toBeVisible();
  assert.equal(f.operations.filter((q) => q.op === "apply").length, 1);
  // Reuse the integrated private source viewer; no external browser window.
  f.intake.inspect = f.d.inspect;
  f.intake.probe = async () => ({
    repository: "me/first",
    repositoryId: 42,
    identity: { id: 7, login: "actual-user" },
    access: "write",
    record: {
      type: "issue",
      number: 1,
      title: "Картинки без мигания",
      body: "Exact published body",
      author: { id: 7, login: "actual-user" },
      state: "open",
      url: "https://github.com/me/first/issues/1",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      comments: 0,
      labels: [],
      assignees: [],
    },
    commentsPage: [],
    nextPage: null,
  });
  await drawer.getByRole("button", { name: "Открыть Issue #1", exact: true }).click();
  await expect(page.getByText("Exact published body", { exact: true })).toBeVisible();
  assert.equal(context.pages().length, 1);
  await page.getByRole("button", { name: "Закрыть событие" }).click();
  await drawer.getByRole("button", { name: "Исходное сообщение", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Исходное сообщение Issue" })).toBeVisible();
  await page.getByRole("button", { name: "Закрыть источник", exact: true }).click();
  const previous = f.d.list().items[0];
  await drawer.getByRole("button", { name: "Убрать", exact: true }).click();
  await expect(drawer.locator(".issue-draft-card")).toHaveCount(0);
  await drawer.getByRole("button", { name: "Закрыть подборку" }).click();
  await intakeDialog
    .locator(".message-short-block")
    .getByRole("button", { name: "В Issues", exact: true })
    .click();
  let lostCapture = false;
  await page.route("**/api/issue-drawer/items/*", async (route) => {
    if (route.request().method() !== "PUT" || lostCapture) return route.continue();
    const response = await route.fetch();
    if (response.ok()) {
      lostCapture = true;
      await route.abort("failed");
    } else await route.fulfill({ response });
  });
  await drawer.getByRole("button", { name: "Добавить в подборку" }).click();
  await expect(drawer.getByRole("alert")).toBeVisible();
  assert(lostCapture);
  const replacement = f.d.list().items[0];
  assert.notEqual(replacement.id, previous.id);
  await drawer.getByRole("button", { name: "Добавить в подборку" }).click();
  await expect(body).toHaveValue(replacement.original);
  assert.equal(f.d.list().items.length, 1);
  assert.equal(f.d.list().items[0].id, replacement.id);
  assert.equal(f.operations.filter((q) => q.op === "apply").length, 1);
  await page.unroute("**/api/issue-drawer/items/*");
  await drawer.getByRole("button", { name: "Закрыть подборку" }).click();
  await intakeDialog.getByRole("button", { name: "Закрыть разбор" }).click();
  await page.getByRole("button", { name: "Закрыть обзор проекта" }).click();
  await expect(composer).toHaveValue("Не потерять черновик");
  assert.deepEqual(errors, []);
  console.log(
    `${engine}: exact block collection, retained editor, reviewed one-time dispatch, internal Issue/source and four-theme responsive geometry passed.`,
  );
} finally {
  await browser.close();
  await f.close();
}
