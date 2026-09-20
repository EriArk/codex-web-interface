import assert from "node:assert/strict";
import { chromium, expect, webkit } from "@playwright/test";
import { devicesFixture } from "./devices-fixture.mjs";

for (const [engine, type] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
  const origin = "http://127.0.0.1:18874",
    f = await devicesFixture(origin);
  f.store.setPreferences({
    projectId: "project",
    threadId: f.thread.id,
    theme: "crt-green",
    view: "chat",
  });
  f.store.result(f.thread.id, "turn", "retained", "check", "Сохранённый результат", {
    exitCode: 0,
  });
  const browser = await type.launch(),
    context = await browser.newContext({
      viewport: { width: 1366, height: 1024 },
      serviceWorkers: "block",
    });
  try {
    await f.app.listen({ host: "127.0.0.1", port: 18874 });
    const [name, value] = f.headers.cookie.split("=");
    await context.addCookies([{ name, value, url: origin, httpOnly: true }]);
    await context.addInitScript(() => {
      window.remoteUrls = [];
      window.remoteClients = [];
      window.remoteConnections = 0;
      window.remoteDisconnections = 0;
      window.Guacamole = {
        WebSocketTunnel: class {
          constructor(url) {
            window.remoteUrls.push(url);
          }
        },
        Keyboard: class {
          reset() {}
        },
        Client: class {
          constructor() {
            window.remoteClients.push(this);
            const canvas = document.createElement("canvas");
            canvas.width = 1280;
            canvas.height = 720;
            canvas.getContext("2d").fillRect(0, 0, 1280, 720);
            this.display = {
              getElement: () => canvas,
              getWidth: () => 1280,
              getHeight: () => 720,
              scale: () => {},
              showCursor: () => {},
              flatten: () => canvas,
              flush: (fn) => fn(),
            };
          }
          getDisplay() {
            return this.display;
          }
          sendMouseState() {}
          sendKeyEvent() {}
          connect() {
            window.remoteConnections++;
            setTimeout(() => {
              this.onstatechange?.(3);
              this.onsync?.();
            }, 0);
          }
          disconnect() {
            window.remoteDisconnections++;
          }
        },
      };
    });

    await context.addInitScript(() => {
      const Original = window.WebSocket;
      window.terminalSockets = [];
      window.WebSocket = class extends Original {
        constructor(url, protocols) {
          super(url, protocols);
          if (String(url).includes("device-terminals")) window.terminalSockets.push(this);
        }
      };
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.route(/\/api\/projects(?:\?|$)/, async (route) => {
      const response = await route.fetch(),
        data = await response.json();
      for (const project of data.projects) project.remoteAvailable = true;
      await route.fulfill({ response, json: data });
    });
    await page.goto(origin);
    const button = (name) =>
      page.getByRole("button", { name, exact: true }).filter({ visible: true }).first();
    const editor = page.getByRole("textbox", { name: "Сообщение Codex" });
    await editor.fill("Keep draft");
    const result = page.getByRole("heading", { name: "Сохранённый результат", exact: true });
    await expect(result).toBeVisible();
    let failRead = true,
      releaseRead;
    await page.route("**/api/projects/project/results?*", async (route) => {
      if (failRead)
        return route.fulfill({
          status: 503,
          json: { error: { code: "TRANSPORT_UNAVAILABLE", message: "Временный сбой" } },
        });
      await new Promise((resolve) => {
        releaseRead = resolve;
      });
      await route.continue();
    });
    f.sessions.emitEvent(f.thread.id, "result.created", { id: "retained" }, "turn");
    const resultsError = page.locator(".results-error");
    await expect(resultsError).toContainText("Временный сбой");
    await expect(result).toBeVisible();
    failRead = false;
    await resultsError.getByRole("button", { name: "Повторить", exact: true }).click();
    await expect.poll(() => !!releaseRead).toBe(true);
    await expect(result).toBeVisible();
    releaseRead();
    await expect(resultsError).toHaveCount(0);
    await page.unroute("**/api/projects/project/results?*");
    await button("Открыть устройства").click();
    await button("Открыть терминал").click();
    const terminal = page.locator(".device-terminal-status");
    await expect(terminal).toContainText("Подключено");
    await expect(button("Подключиться снова")).toHaveCount(0);
    await button("Открыть клавиатуру").click();
    await page.keyboard.type("once");
    await page.keyboard.press("Enter");
    await expect.poll(() => f.processes[0].writes.join("")).toContain("once\r");
    const written = f.processes[0].writes.join("");
    await page.evaluate(() => window.terminalSockets.at(-1).close());
    await expect.poll(() => page.evaluate(() => window.terminalSockets.length)).toBe(2);
    await expect(terminal).toContainText("Подключено");
    assert.equal(f.processes.length, 1, "reattach never creates another shell");
    assert.equal(f.processes[0].writes.join(""), written, "input is never replayed");
    await page.evaluate(() => {
      const ws = window.terminalSockets.at(-1),
        closed = ws.onclose;
      ws.onclose = null;
      ws.close();
      closed(new CloseEvent("close", { code: 1008 }));
    });
    await expect(button("Подключиться снова")).toBeVisible();
    await button("Подключиться снова").click();
    await expect(terminal).toContainText("Подключено");
    f.processes[0].kill();
    await expect(terminal).toContainText("Завершено");
    await expect(button("Подключиться снова")).toHaveCount(0);
    await button("Закрыть устройства").click();
    await button("Открыть Remote").click();
    const remote = page.getByRole("dialog", { name: "Remote ПК", exact: true });
    await expect(remote.getByText("Подключено", { exact: true })).toBeVisible();
    await page.evaluate(() => window.remoteClients.at(-1).onstatechange(5));
    await expect(remote.getByRole("button", { name: "Подключиться снова" })).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.remoteConnections)).toBe(2);
    await expect(remote.getByText("Подключено", { exact: true })).toBeVisible();
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, value: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect.poll(() => page.evaluate(() => window.remoteDisconnections)).toBe(2);
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, value: false });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect.poll(() => page.evaluate(() => window.remoteConnections)).toBe(3);
    await expect(remote.getByText("Подключено", { exact: true })).toBeVisible();
    await page.evaluate(() =>
      window.remoteClients.at(-1).onerror({ code: 771, message: "Нет доступа" }),
    );
    await expect(remote.getByRole("button", { name: "Подключиться снова" })).toBeVisible();
    await remote.getByRole("button", { name: "Подключиться снова" }).click();
    await expect.poll(() => page.evaluate(() => window.remoteConnections)).toBe(4);
    await remote.getByRole("button", { name: "Назад к чату", exact: true }).click();
    await expect(remote).toHaveCount(0);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    assert.equal(
      await page.evaluate(() => window.remoteConnections),
      4,
      "closed Remote stays closed",
    );
    await expect(editor).toHaveValue("Keep draft");
    assert.deepEqual(errors, []);
    assert(!f.calls.some((c) => ["turn/start", "turn/interrupt"].includes(c.method)));
    console.log(
      engine +
        ": same terminal, no input replay, ended/auth handling; Remote reconnect, wake, close and draft continuity",
    );
  } finally {
    await browser.close();
    await f.close();
  }
}
