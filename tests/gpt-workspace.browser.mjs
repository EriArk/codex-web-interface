import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, expect, webkit } from "@playwright/test";
import { handoffFixture } from "./handoff-fixture.mjs";

for (const [engine, type] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
  const origin = "http://127.0.0.1:18932",
    f = await handoffFixture(origin),
    browser = await type.launch(),
    context = await browser.newContext({
      viewport: { width: 393, height: 852 },
      hasTouch: true,
      serviceWorkers: "block",
    });
  try {
    await f.app.listen({ port: 18932, host: "127.0.0.1" });
    const [name, value] = f.headers.cookie.split("=");
    await context.addCookies([{ name, value, url: origin, httpOnly: true }]);
    await context.addInitScript(() => {
      localStorage.setItem("codex-client", "gpt");
      localStorage.setItem("gpt-conversation", "chat");
    });
    const page = await context.newPage(),
      errors = [],
      writes = [];
    page.on("pageerror", (e) => errors.push(e.message));
    let task = {
        id: "task-1",
        title: "Утренние новости",
        prompt: "Найти интересные новости",
        enabled: true,
        schedule: "BEGIN:VEVENT\nRRULE:FREQ=DAILY;BYHOUR=9\nEND:VEVENT",
        displaySchedule: "Каждый день в 9:00",
        timezone: "Asia/Jerusalem",
        timing: "exact_schedule",
        nextRuns: ["2027-01-01T07:00:00Z"],
        lastRun: null,
        conversationId: "chat",
        eventDriven: false,
        canEdit: true,
        canDelete: true,
        revision: "a".repeat(64),
      },
      doc = {
        id: "doc",
        conversationId: "chat",
        title: "Документ проекта",
        type: "document",
        content: "Текущая версия\n<script>window.badCanvas=true</script>",
        version: 3,
        revision: "a".repeat(64),
      },
      ops = [],
      loseAck = true;
    await page.route("**/api/gpt/**", async (route) => {
      const r = route.request(),
        url = new URL(r.url()),
        p = url.pathname,
        j = (v) => route.fulfill({ json: v });
      if (p === "/api/gpt/status") return j({ configured: true, canSend: true, state: "healthy" });
      if (p === "/api/gpt/models")
        return j({
          models: [{ id: "Latest", label: "Latest" }],
          efforts: [{ id: "2", label: "High" }],
          currentModel: "Latest",
          currentEffort: "2",
        });
      if (p === "/api/gpt/conversations")
        return j({ items: [{ id: "chat", title: "Мой чат", updatedAt: 1 }], nextOffset: null });
      if (p.endsWith("/messages"))
        return j({
          items: [{ id: "u", role: "user", text: "Сообщение", files: [], createdAt: 1 }],
          nextBefore: null,
          revision: "a".repeat(64),
          prefix: "",
          notModified: false,
          retainOlder: false,
        });
      if (p === "/api/gpt/scheduled") return j({ items: [task], cursor: null });
      if (p === "/api/gpt/canvas") return j({ items: [doc] });
      if (p === "/api/gpt/canvas/version")
        return j({
          ...doc,
          version: Number(url.searchParams.get("version")),
          content: "Исходный текст",
        });
      if (p === "/api/gpt/workspace-operations") {
        if (r.method() === "GET") return j({ items: ops });
        const input = r.postDataJSON(),
          id = r.headers()["idempotency-key"];
        writes.push({ id, input });
        if (!ops.some((o) => o.id === id)) {
          const stale =
            input.revision !== (input.kind === "schedule" ? task.revision : doc.revision);
          ops.unshift({
            id,
            kind: input.kind,
            targetId: input.id,
            state: stale ? "failed" : input.kind === "canvas" ? "completed" : "unknown",
            error: stale ? "Данные изменились. Черновик сохранён." : "Подтверждение потеряно",
          });
          if (input.kind === "canvas") {
            doc = { ...doc, version: 4, content: "Исходный текст", revision: "d".repeat(64) };
          }
        }
        if (loseAck && input.revision === task.revision && input.kind === "schedule") {
          loseAck = false;
          return route.abort("failed");
        }
        return j({ id });
      }
      if (p.includes("/workspace-operations/")) {
        const parts = p.split("/"),
          id = parts[4],
          op = ops.find((o) => o.id === id);
        if (!op)
          return route.fulfill({
            status: 404,
            json: { error: { code: "MISSING", message: "Нет" } },
          });
        if (p.endsWith("/check")) {
          const sent = writes.find((w) => w.id === id);
          task = { ...task, ...sent.input, revision: "c".repeat(64) };
          op.state = "completed";
          op.error = "";
        }
        return j(op);
      }
      if (p === "/api/gpt/send") {
        writes.push({ send: r.postDataJSON(), id: r.headers()["idempotency-key"] });
        return j({
          job: {
            id: "job-fixture",
            status: "completed",
            nativeId: "new-chat",
            error: "",
            createdAt: 1,
            updatedAt: 1,
          },
        });
      }
      return j({
        items: [],
        conversations: [],
        nextOffset: null,
        blocked: false,
        stamp: Date.now(),
      });
    });
    await page.goto(origin);
    const composer = page.getByRole("textbox", { name: "Сообщение GPT" });
    await expect(composer).toBeVisible();
    await composer.fill("Мой несохранённый чат");
    const openSchedules = async () => {
      await page.getByRole("button", { name: "Открыть проекты", exact: true }).click();
      await page.getByRole("button", { name: "Задачи", exact: true }).last().click();
      await page.getByRole("button", { name: "Расписания ChatGPT", exact: true }).click();
    };
    await openSchedules();
    const modal = page.getByRole("dialog", { name: "Расписания ChatGPT" });
    await modal.getByRole("button", { name: /Утренние новости/ }).click();
    const prompt = modal.getByRole("textbox", { name: "Что должен делать ChatGPT" });
    await prompt.fill("Черновик расписания");
    await modal.getByRole("button", { name: "Закрыть", exact: true }).click();
    task = { ...task, prompt: "Изменено в другом клиенте", revision: "b".repeat(64) };
    await openSchedules();
    await modal.getByRole("button", { name: /Утренние новости/ }).click();
    await expect(prompt).toHaveValue("Черновик расписания");
    await modal.getByRole("button", { name: "Сохранить", exact: true }).click();
    await expect(modal.getByRole("alert")).toContainText("Данные изменились");
    await expect(prompt).toHaveValue("Черновик расписания");
    await modal.getByRole("button", { name: "Вернуть данные из ChatGPT" }).click();
    await expect(prompt).toHaveValue("Изменено в другом клиенте");
    await prompt.fill("Проверить новый выпуск");
    await modal.getByRole("button", { name: "Сохранить", exact: true }).click();
    await expect(
      modal.getByRole("button", { name: "Проверить результат", exact: true }),
    ).toBeVisible();
    await modal.getByRole("button", { name: "Проверить результат", exact: true }).click();
    await expect(
      modal.getByRole("button", { name: "Проверить результат", exact: true }),
    ).toHaveCount(0);
    await modal.getByRole("button", { name: "Сохранить", exact: true }).click();
    assert.equal(
      writes.length,
      2,
      "Checking a completed lost-ack receipt must not replay the mutation",
    );
    await mkdir(`.local/qa-native-workspace/${engine}`, { recursive: true });
    for (const theme of ["organizer", "classic-dark", "crt-green", "hitech-2000s"]) {
      await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
      for (const width of [393, 1366]) {
        await page.setViewportSize({ width, height: width === 393 ? 852 : 1024 });
        const rect = await modal.boundingBox();
        assert(rect.x >= 0 && rect.x + rect.width <= width + 1);
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await page.screenshot({
          path: `.local/qa-native-workspace/${engine}/${theme}-${width}.png`,
        });
      }
    }
    await page.setViewportSize({ width: 393, height: 852 });
    await modal.getByRole("button", { name: "Новое расписание", exact: true }).click();
    await modal.getByRole("textbox", { name: "Название", exact: true }).fill("Моя задача");
    await modal.getByRole("textbox", { name: "Поручение", exact: true }).fill("Проверить погоду");
    await modal.getByRole("textbox", { name: "Когда", exact: true }).fill("Завтра в 9:00");
    await modal.getByRole("button", { name: "Создать через GPT" }).click();
    await expect(modal.getByText("Ответ получен.", { exact: false })).toBeVisible();
    assert.equal(writes.at(-1).send.nativeId, null);
    assert(writes.at(-1).send.text.includes("Завтра в 9:00"));
    await modal.getByRole("button", { name: "Закрыть", exact: true }).click();
    await expect(composer).toHaveValue("Мой несохранённый чат");
    await page.getByRole("button", { name: "Документы Canvas", exact: true }).click();
    const canvas = page.getByRole("dialog", { name: "Canvas этого чата" });
    await canvas.getByRole("button", { name: /Документ проекта/ }).click();
    await expect(canvas.locator("pre")).toContainText("<script>");
    assert.equal(await page.evaluate(() => window.badCanvas), undefined);
    await canvas.getByRole("spinbutton", { name: "Версия", exact: true }).fill("1");
    await canvas.getByRole("button", { name: "Показать версию" }).click();
    await expect(canvas.locator("pre")).toHaveText("Исходный текст");
    await canvas.getByRole("button", { name: "Восстановить эту версию" }).click();
    await canvas.getByRole("button", { name: "Да, восстановить" }).click();
    await expect(canvas.getByText("Версия 4 из 4.", { exact: false })).toBeVisible();
    assert.equal(writes.at(-1).input.conversationId, "chat");
    await canvas.getByRole("button", { name: "Закрыть", exact: true }).click();
    await expect(composer).toHaveValue("Мой несохранённый чат");
    assert.deepEqual(errors, []);
    console.log(
      engine +
        ": native schedules drafts/conflicts/lost acknowledgement/create, Canvas versions/restore, isolation, four themes and phone/tablet passed",
    );
  } finally {
    await context.close();
    await browser.close();
    await f.close();
  }
}
