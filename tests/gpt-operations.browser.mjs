import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, expect, webkit } from "@playwright/test";
import { handoffFixture } from "./handoff-fixture.mjs";

for (const [engine, type] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
  const origin = "http://127.0.0.1:18926",
    f = await handoffFixture(origin),
    browser = await type.launch(),
    context = await browser.newContext({
      viewport: { width: 393, height: 852 },
      hasTouch: true,
      serviceWorkers: "block",
    });
  try {
    await f.app.listen({ port: 18926, host: "127.0.0.1" });
    const [name, value] = f.headers.cookie.split("=");
    await context.addCookies([{ name, value, url: origin, httpOnly: true }]);
    await context.addInitScript(() => {
      localStorage.setItem("codex-client", "gpt");
      localStorage.setItem("gpt-conversation", "chat");
    });
    const page = await context.newPage(),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    let messages = [
        { id: "u", role: "user", text: "Исходное сообщение", files: [], createdAt: 1 },
        { id: "a", role: "assistant", text: "Исходный ответ", files: [], createdAt: 2 },
      ],
      ops = [],
      requests = [],
      revision = 1,
      failAck = true;
    await page.route("**/api/gpt/**", async (route) => {
      const request = route.request(),
        url = new URL(request.url()),
        path = url.pathname;
      const json = (value) => route.fulfill({ json: value });
      if (path === "/api/gpt/status")
        return json({ configured: true, canSend: true, state: "healthy" });
      if (path === "/api/gpt/models")
        return json({
          models: [{ id: "Latest", label: "Latest" }],
          efforts: [{ id: "2", label: "High" }],
          currentModel: "Latest",
          currentEffort: "2",
        });
      if (path === "/api/gpt/conversations")
        return json({
          items: [{ id: "chat", title: "Проверка веток", updatedAt: 1 }],
          nextOffset: null,
        });
      if (path.endsWith("/messages"))
        return json({
          items: messages,
          nextBefore: null,
          revision: String(revision).repeat(64),
          prefix: "",
          notModified: false,
          retainOlder: false,
        });
      if (path.endsWith("/action"))
        return json({
          currentNode: "a",
          message: messages.find((m) => m.id === path.split("/").at(-2)),
        });
      if (path.endsWith("/versions"))
        return url.searchParams.has("targetMessageId")
          ? json({
              currentNode: "a2",
              messages: [
                { id: "u", role: "user", text: "Исходное сообщение", files: [], createdAt: 1 },
                { id: "a", role: "assistant", text: "Исходный ответ", files: [], createdAt: 2 },
              ],
              hasOlder: false,
            })
          : json({
              currentNode: "a2",
              items: [
                {
                  nodeId: "u2",
                  messageId: "u2",
                  text: "Исправленное сообщение",
                  current: true,
                  createdAt: 3,
                },
                {
                  nodeId: "u",
                  messageId: "u",
                  text: "Исходное сообщение",
                  current: false,
                  createdAt: 1,
                },
              ],
            });
      if (path === "/api/gpt/native-operations") {
        if (request.method() === "GET")
          return json({
            items: ops,
            blocked: ops.some((o) => ["unknown", "running"].includes(o.state)),
          });
        const input = request.postDataJSON(),
          id = request.headers()["idempotency-key"];
        requests.push({ id, input });
        if (!ops.some((op) => op.id === id))
          ops.unshift({
            ...input,
            id,
            state: "unknown",
            error: "Подтверждение потеряно",
            createdAt: Date.now(),
            updatedAt: Date.now(),
          });
        if (failAck) {
          failAck = false;
          return route.abort("failed");
        }
        return json({ id });
      }
      if (path.endsWith("/check")) {
        ops[0].state = "completed";
        revision++;
        if (ops[0].action === "fork") ops[0].resultNativeId = "new-branch";
        else
          messages = [
            { ...messages[0], id: "u2", text: ops[0].text },
            { ...messages[1], id: "a2", text: "Новый ответ" },
          ];
        return json({ ok: true });
      }
      return json({ items: [], conversations: [], nextOffset: null, stamp: Date.now() });
    });
    await page.goto(origin);
    await expect(page.getByRole("textbox", { name: "Сообщение GPT" })).toBeVisible();
    await page.getByRole("textbox", { name: "Сообщение GPT" }).fill("Отдельный черновик");
    await page.getByRole("button", { name: "Изменить сообщение GPT", exact: true }).click();
    const modal = page.getByRole("dialog", { name: "Изменить сообщение GPT" }),
      editor = modal.getByRole("textbox", { name: "Изменённое сообщение" });
    await editor.fill("Исправленное сообщение\nВторая строка");
    await mkdir(`.local/qa-gpt-operations/${engine}`, { recursive: true });
    for (const theme of ["classic-dark", "organizer", "crt-green", "hitech-2000s"]) {
      await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
      for (const width of [320, 393, 1366]) {
        await page.setViewportSize({ width, height: width < 1100 ? 852 : 1024 });
        const rect = await modal.boundingBox();
        assert(rect.x >= 0 && rect.x + rect.width <= width + 1);
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await page.screenshot({ path: `.local/qa-gpt-operations/${engine}/${theme}-${width}.png` });
      }
    }
    await modal.getByRole("button", { name: "Сохранить и отправить", exact: true }).click();
    await expect(editor).toBeDisabled();
    await modal.getByRole("button", { name: "Проверить отправку", exact: true }).click();
    await expect(modal).not.toBeVisible();
    assert.equal(requests.length, 2);
    assert.equal(requests[0].id, requests[1].id);
    assert.deepEqual(requests[0].input, requests[1].input);
    await expect(page.getByRole("button", { name: "Отправить GPT", exact: true })).toBeDisabled();
    await expect(page.getByRole("textbox", { name: "Сообщение GPT" })).toHaveValue(
      "Отдельный черновик",
    );
    await page.getByRole("button", { name: "Проверить историю", exact: true }).click();
    await expect(page.locator('[data-message="u2"]')).toContainText("Исправленное сообщение");
    await expect(page.getByRole("button", { name: "Отправить GPT", exact: true })).toBeEnabled();
    assert.equal(requests.length, 2);
    await page.getByRole("button", { name: "Изменить сообщение GPT", exact: true }).click();
    await page.getByRole("button", { name: "Версии сообщения", exact: true }).click();
    const versions = page.getByRole("dialog", { name: "Версии сообщения", exact: true });
    await versions.getByRole("button", { name: /Версия 2/ }).click();
    await expect(versions.getByLabel("Просмотр версии")).toContainText("Исходный ответ");
    assert.equal(requests.length, 2);
    await versions.getByRole("button", { name: "Продолжить в новом чате" }).click();
    const fork = page.getByRole("dialog", { name: "Продолжить версию GPT" });
    await fork
      .getByRole("textbox", { name: "Первое сообщение новой ветки" })
      .fill("Продолжим старую версию");
    await fork.getByRole("button", { name: "Создать чат и отправить" }).click();
    await page.getByRole("button", { name: "Проверить историю", exact: true }).click();
    await page.getByRole("button", { name: "Открыть новую ветку", exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem("gpt-conversation")))
      .toBe("new-branch");
    assert.equal(requests.length, 3);
    assert.equal(requests[2].input.action, "fork");
    assert.equal(requests[2].input.targetMessageId, "u");
    assert.deepEqual(errors, []);
    console.log(
      engine +
        ": GPT edit draft, exact retry, unknown outcome, branch refresh and four-theme phone/tablet geometry passed",
    );
  } finally {
    await context.close();
    await browser.close();
    await f.close();
  }
}
