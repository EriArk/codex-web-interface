import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, expect, webkit } from "@playwright/test";
import { usageFixture } from "./usage-resets-fixture.mjs";

for (const [engine, type] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
  const origin = "http://127.0.0.1:18936",
    f = await usageFixture(origin);
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
      reducedMotion: "reduce",
    });
  try {
    await f.app.listen({ port: 18936, host: "127.0.0.1" });
    const [name, value] = f.headers.cookie.split("=");
    await context.addCookies([{ name, value, url: origin, httpOnly: true }]);
    await context.addInitScript(() => {
      window.remoteUrls = [];
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
    const page = await context.newPage(),
      errors = [],
      gptWrites = [];
    let remoteAvailable = true;
    page.on("pageerror", (e) => errors.push(e.message));
    await page.route(/\/api\/projects(?:\?|$)/, async (route) => {
      const response = await route.fetch(),
        data = await response.json();
      for (const project of data.projects) project.remoteAvailable = remoteAvailable;
      await route.fulfill({ response, json: data });
    });
    await context.route("**/gpt-connect?immersive=1", (route) =>
      route.fulfill({ contentType: "text/html", body: "<title>Private browser fixture</title>" }),
    );
    await page.route("**/api/gpt/**", (route) => {
      const request = route.request(),
        path = new URL(request.url()).pathname;
      if (request.method() !== "GET") gptWrites.push(path);
      const data = /\/(status|reconnect)$/.test(path)
        ? { configured: true, canSend: true, state: "healthy", message: "ChatGPT подключён" }
        : path.endsWith("/models")
          ? {
              models: [
                { id: "Latest", label: "Latest" },
                ...(gptWrites.length ? [{ id: "verified", label: "После проверки" }] : []),
              ],
              efforts: [{ id: "2", label: "High" }],
              currentModel: "Latest",
              currentEffort: "2",
            }
          : { items: [], conversations: [], nextOffset: null, blocked: false, stamp: 1 };
      return route.fulfill({ json: data });
    });
    const button = (name) =>
      page.getByRole("button", { name, exact: true }).filter({ visible: true }).first();
    const navigation = async () => {
      if (!(await button("Настройки").isVisible())) await button("Открыть проекты").click();
    };
    const settings = page.getByRole("dialog", { name: "Настройки", exact: true });
    const limits = settings
      .getByRole("region", { name: "Лимиты Codex: PC", exact: true })
      .filter({ visible: true });
    const openSettings = async () => {
      await navigation();
      await button("Настройки").click();
    };
    const category = async (id) => {
      if (!(await settings.locator(".settings-categories").isVisible()))
        await button("Все категории настроек").click();
      await settings.locator(`[data-category="${id}"]`).click();
    };
    await page.goto(origin);
    const codex = page.getByRole("textbox", { name: "Сообщение Codex" });
    await codex.fill("Черновик Codex остаётся");
    await codex.blur();
    await openSettings();
    await expect(limits.getByText("37% осталось", { exact: true })).toBeVisible();
    await settings.evaluate((el) => {
      window.settingsElement = el;
    });
    await button("Закрыть настройки").click();
    await navigation();
    await button("Переключиться на GPT").click();
    const gpt = page.getByRole("textbox", { name: "Сообщение GPT" });
    await gpt.fill("Черновик GPT остаётся");
    await gpt.blur();
    await gpt.evaluate((el) => {
      window.gptEditor = el;
    });
    await openSettings();
    assert(
      await settings.evaluate((el) => el === window.settingsElement),
      "one mounted Settings host across modes",
    );
    await expect(limits.getByText("37% осталось", { exact: true })).toBeVisible();
    await limits.getByRole("button", { name: "Активировать", exact: true }).first().click();
    await limits.getByRole("button", { name: "Использовать сброс", exact: true }).click();
    await expect(limits.getByText("100% осталось", { exact: true })).toHaveCount(2);
    assert.equal(
      f.state.consumes.length,
      1,
      "GPT Settings redeems the same authorized Codex account once",
    );
    await category("connections");
    await expect(
      settings.getByRole("region", { name: "Подключение Codex", exact: true }),
    ).toBeVisible();
    await expect(
      settings.getByRole("region", { name: "Подключение GPT", exact: true }),
    ).toBeVisible();
    await expect(limits.getByText("100% осталось", { exact: true })).toHaveCount(2);
    assert.deepEqual(gptWrites, [], "opening Settings does not prepare or reconnect GPT");
    await button("Перепроверить подключение").click();
    await expect.poll(() => gptWrites.length).toBe(1);
    assert.deepEqual(gptWrites, ["/api/gpt/reconnect"]);
    const browserLink = settings.getByRole("link", {
      name: "Браузер ChatGPT на сервере",
      exact: true,
    });
    await expect(browserLink).toHaveAttribute("href", "/gpt-connect?immersive=1");
    const popupPromise = context.waitForEvent("page");
    await browserLink.click();
    const popup = await popupPromise;
    await popup.waitForLoadState();
    assert(popup.url().endsWith("/gpt-connect?immersive=1"));
    await popup.close();
    assert.equal(page.url(), `${origin}/`);
    await button("Закрыть настройки").click();
    assert(await gpt.evaluate((el) => el === window.gptEditor));
    await expect(gpt).toHaveValue("Черновик GPT остаётся");
    await expect(
      page.getByRole("combobox", { name: "Модель GPT" }).locator('option[value="verified"]'),
    ).toHaveCount(1);
    await mkdir(`.local/qa-shared-settings/${engine}`, { recursive: true });
    for (const client of ["GPT", "Codex"]) {
      if (client === "Codex") {
        await navigation();
        await button("Переключиться на Codex").click();
      }
      const editor = page.getByRole("textbox", { name: `Сообщение ${client}` });
      await editor.evaluate((el) => {
        window.currentEditor = el;
      });
      for (const width of [390, 1366]) {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 1024 });
        await navigation();
        await button("Открыть Remote").click();
        const remote = page.getByRole("dialog", { name: "Remote ПК", exact: true });
        await expect(remote.getByText("Подключено", { exact: true })).toBeVisible();
        assert.equal(
          await page.evaluate(() => new URL(window.remoteUrls.at(-1)).pathname),
          "/api/projects/project/remote",
        );
        assert.equal(page.url(), `${origin}/`);
        const rect = await remote.boundingBox();
        assert.equal(Math.round(rect.width), width);
        assert.equal(Math.round(rect.height), width === 390 ? 844 : 1024);
        await page.screenshot({
          path: `.local/qa-shared-settings/${engine}/${client}-remote-${width}.png`,
        });
        await remote
          .getByRole("button", {
            name: width === 390 ? "Назад к чату" : "Свернуть Remote",
            exact: true,
          })
          .click();
        await expect(remote).toHaveCount(0);
        assert(
          await editor.evaluate((el) => el === window.currentEditor),
          "Remote must preserve the mounted composer",
        );
        await expect(editor).toHaveValue(`Черновик ${client} остаётся`);
      }
      await openSettings();
      await expect(limits.getByText("100% осталось", { exact: true })).toHaveCount(2);
      await category("library");
      await expect(
        settings.getByRole("region", { name: "История Codex", exact: true }),
      ).toBeVisible();
      await expect(
        settings.getByRole("region", { name: "История GPT", exact: true }),
      ).toBeVisible();
      await button("Закрыть настройки").click();
    }
    assert.equal(await page.evaluate(() => window.remoteConnections), 4);
    assert.equal(await page.evaluate(() => window.remoteDisconnections), 4);
    assert(!f.calls.some((c) => ["turn/start", "turn/steer", "turn/interrupt"].includes(c.method)));
    assert(f.desktopCalls.every((action) => action === "Status"));
    remoteAvailable = false;
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(codex).toBeVisible();
    await navigation();
    await button("Открыть Remote").click();
    await expect(page.getByText("Remote ПК пока не настроен", { exact: true })).toBeVisible();
    assert.equal(
      await page.evaluate(() => window.remoteUrls.length),
      0,
      "missing PC never falls back to the server GPT browser",
    );
    assert.deepEqual(errors, []);
    console.log(
      `${engine}: one Settings host, Codex limits/resets in GPT, separated connections, private browser popup, PC Remote from both modes, fullscreen/draft continuity and no server fallback passed`,
    );
  } finally {
    await context.close();
    await browser.close();
    await f.close();
  }
}
