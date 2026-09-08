import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, expect, webkit } from "@playwright/test";
import { handoffFixture } from "./handoff-fixture.mjs";

await mkdir(".local/qa-push", { recursive: true });
for (const [engine, type] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
  const sent = [],
    origin = "http://127.0.0.1:18847";
  const f = await handoffFixture(origin, undefined, {
    push: {
      keys: { publicKey: "A".repeat(87), privateKey: "B".repeat(43) },
      automatic: false,
      send: async (_s, p) => sent.push(JSON.parse(p)),
    },
  });
  const browser = await type.launch();
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    serviceWorkers: "block",
  });
  try {
    await f.app.listen({ port: 18847, host: "127.0.0.1" });
    const [name, value] = f.headers.cookie.split("=");
    await context.addCookies([{ name, value, url: origin, httpOnly: true, sameSite: "Strict" }]);
    await context.addInitScript(
      ({ threadId }) => {
        localStorage.setItem("codex-project", "project");
        localStorage.setItem("codex-thread", threadId);
        localStorage.setItem("codex-theme", "crt-green");
        window.pushCalls = [];
        window.mockPermission = "default";
        window.mockSub = null;
        const sub = {
          toJSON: () => ({
            endpoint: "https://web.push.apple.com/browser-test",
            keys: { p256dh: "C".repeat(87), auth: "D".repeat(22) },
          }),
          unsubscribe: async () => {
            window.mockSub = null;
            return true;
          },
        };
        Object.defineProperty(window, "Notification", {
          configurable: true,
          value: class {
            static get permission() {
              return window.mockPermission;
            }
          },
        });
        Object.defineProperty(window, "PushManager", { configurable: true, value: class {} });
        Object.defineProperty(navigator.serviceWorker, "ready", {
          configurable: true,
          value: Promise.resolve({
            pushManager: {
              getSubscription: async () => window.mockSub,
              subscribe: async () => {
                window.pushCalls.push({ active: navigator.userActivation?.isActive });
                window.mockPermission = "granted";
                window.mockSub = sub;
                return sub;
              },
            },
          }),
        });
      },
      { threadId: f.thread.id },
    );
    const page = await context.newPage(),
      errors = [];
    // WebKit reports requests cancelled by full navigation as access-control pageerrors.
    page.on("pageerror", (e) => {
      if (!/^\/127\.0\.0\.1:18847\/api\/.* due to access control checks\.$/.test(e.message))
        errors.push(e.message);
    });
    await page.goto(origin);
    const editor = page.getByRole("textbox", { name: "Сообщение Codex" });
    await expect(editor).toBeVisible();
    await editor.fill("Черновик должен сохраниться");
    await page.getByRole("button", { name: "Настройки", exact: true }).click();
    const panel = page.getByRole("region", { name: "Уведомления", exact: true });
    const enable = panel.getByRole("button", { name: "Включить на этом устройстве" });
    await expect(enable).toBeEnabled();
    assert.equal(
      await page.evaluate(() => window.pushCalls.length),
      0,
      "permission must not be requested on mount",
    );
    await enable.click();
    const disable = panel.getByRole("button", { name: "Выключить на этом устройстве" });
    await expect(disable).toBeEnabled();
    assert.equal(
      await page.evaluate(() => window.pushCalls[0].active),
      true,
      "subscribe must retain the user's gesture",
    );
    await panel.getByRole("checkbox", { name: "Завершение работы" }).click();
    await expect(disable).toBeEnabled();
    assert.equal(
      JSON.parse(f.store.db.prepare("SELECT categories FROM push_subscriptions").get().categories)
        .completed,
      false,
    );
    await panel.getByRole("button", { name: "Проверить уведомление" }).click();
    await expect.poll(() => sent.length).toBe(1);
    await panel.screenshot({ path: `.local/qa-push/${engine}-settings.png` });
    for (const theme of ["organizer", "hitech-2000s", "classic-dark"]) {
      await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
      await panel.screenshot({ path: `.local/qa-push/${engine}-${theme}.png` });
    }
    await page.getByRole("button", { name: "Закрыть настройки" }).click();
    await expect(editor).toHaveValue("Черновик должен сохраниться");
    const other = f.store.createThread("project", "notification-native", "Другой диалог");
    f.store.append(other.id, "assistant.completed", { id: "answer", text: "Ответ по уведомлению" });
    const id = "a".repeat(32);
    f.store.db
      .prepare("INSERT INTO push_notices VALUES(?,?,'codex',?,'completed','completed',?,1)")
      .run(id, "browser-open", other.id, Date.now());
    await page.evaluate(
      (id) =>
        navigator.serviceWorker.dispatchEvent(
          new MessageEvent("message", { data: { type: "notification.open", id } }),
        ),
      id,
    );
    await expect(page.getByText("Ответ по уведомлению", { exact: true })).toBeVisible();
    await expect(editor).toHaveValue("");
    assert.equal(await page.evaluate(() => location.hash), "");
    assert.equal(
      f.calls.filter((c) => ["turn/start", "thread/resume"].includes(c.method)).length,
      0,
    );
    assert.equal(f.desktopCalls.filter((a) => a === "ForceRelease").length, 0);
    // Return through a second notification: original text is still bound to its own chat.
    const back = "b".repeat(32);
    f.store.db
      .prepare("INSERT INTO push_notices VALUES(?,?,'codex',?,'completed','completed',?,1)")
      .run(back, "browser-back", f.thread.id, Date.now());
    await page.evaluate(
      (id) =>
        navigator.serviceWorker.dispatchEvent(
          new MessageEvent("message", { data: { type: "notification.open", id } }),
        ),
      back,
    );
    await expect(editor).toHaveValue("Черновик должен сохраниться");
    await page.goto(origin + "/#notification=" + id);
    await page.reload();
    await expect(page.getByText("Ответ по уведомлению", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Настройки", exact: true }).click();
    // A disappeared OS subscription is revoked server-side on opening settings.
    await expect(enable).toBeEnabled();
    assert.equal(f.store.db.prepare("SELECT count(*) n FROM push_subscriptions").get().n, 0);
    await enable.click();
    await expect(disable).toBeEnabled();
    await disable.click();
    await expect(enable).toBeEnabled();
    assert.equal(f.store.db.prepare("SELECT count(*) n FROM push_subscriptions").get().n, 0);
    // GPT uses the same device preferences and resolves the native branch without sending.
    const gptId = "c".repeat(32),
      nativeId = "native-gpt-test";
    f.store.db
      .prepare(
        "INSERT INTO gpt_jobs(id,fingerprint,nativeId,text,files,model,effort,status,answer,assets,createdAt,updatedAt,error) VALUES('push-gpt','fp',?,'','[]','','','completed','','[]',?,?, '')",
      )
      .run(nativeId, Date.now(), Date.now());
    f.store.db
      .prepare("INSERT INTO push_notices VALUES(?,?,'gpt','push-gpt','completed','completed',?,1)")
      .run(gptId, "gpt-open", Date.now());
    await page.route("**/api/gpt/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      let data = { items: [], conversations: [], nextOffset: null };
      if (path.endsWith("/status")) data = { configured: true, canSend: true, state: "healthy" };
      else if (path.endsWith("/models")) data = { models: [], efforts: [] };
      else if (path.endsWith("/jobs")) data = { items: [], stamp: 1 };
      else if (path.endsWith("/conversations"))
        data = { items: [{ id: nativeId, title: "GPT по уведомлению" }], nextOffset: null };
      else if (path.endsWith("/messages"))
        data = {
          items: [
            {
              id: "gpt-answer",
              files: [],
              role: "assistant",
              text: "Ответ GPT по уведомлению",
              createdAt: 1,
            },
          ],
          nextBefore: null,
          revision: "1",
          prefix: "1",
        };
      await route.fulfill({ json: data });
    });
    await page.evaluate(
      (id) =>
        navigator.serviceWorker.dispatchEvent(
          new MessageEvent("message", { data: { type: "notification.open", id } }),
        ),
      gptId,
    );
    await expect(page.getByText("Ответ GPT по уведомлению", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Открыть проекты", exact: true }).click();
    await page
      .getByRole("button", { name: "Настройки", exact: true })
      .filter({ visible: true })
      .last()
      .click();
    await expect(panel.getByRole("button", { name: "Включить на этом устройстве" })).toBeEnabled();
    await panel.screenshot({ path: `.local/qa-push/${engine}-gpt-settings.png` });
    assert.equal(f.calls.filter((c) => c.method === "turn/start").length, 0);
    assert.deepEqual(errors, []);
    console.log(
      engine +
        ": gesture opt-in, settings, revocation, cold/warm deep link, preserved drafts and no writer acquisition passed",
    );
  } finally {
    await context.close();
    await browser.close();
    await f.close();
  }
}
