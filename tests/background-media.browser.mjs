import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { chromium, expect, webkit } from "@playwright/test";
import { handoffFixture } from "./handoff-fixture.mjs";

await mkdir(".local/qa-background-media", { recursive: true });
const wav = Buffer.alloc(44 + 22050 * 2 * 20);
wav.write("RIFF");
wav.writeUInt32LE(wav.length - 8, 4);
wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(22050, 24);
wav.writeUInt32LE(44100, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write("data", 36);
wav.writeUInt32LE(wav.length - 44, 40);
for (let i = 0; i < 22050 * 20; i++)
  wav.writeInt16LE(Math.round(Math.sin((i * 2 * Math.PI * 220) / 22050) * 100), 44 + i * 2);
for (const [engine, type] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
  const origin = "http://127.0.0.1:18866",
    f = await handoffFixture(origin);
  f.store.db
    .prepare("UPDATE threads SET origin='web',status='running' WHERE id=?")
    .run(f.thread.id);
  f.store.setPreferences({
    projectId: "project",
    threadId: f.thread.id,
    view: "chat",
    theme: "crt-green",
  });
  f.store.append(f.thread.id, "assistant.completed", {
    id: "audio-reply",
    text: "Привет. Это проверка озвучивания ответа.",
  });
  const browser = await type.launch(),
    context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      serviceWorkers: "block",
    });
  const errors = [];
  let page;
  try {
    await f.app.listen({ host: "127.0.0.1", port: 18866 });
    const [name, value] = f.headers.cookie.split("=");
    await context.addCookies([{ name, value, url: origin, httpOnly: true, sameSite: "Strict" }]);
    await context.addInitScript(() => {
      const speech = new EventTarget();
      speech.spoken = [];
      speech.calls = [];
      speech.getVoices = () => [
        { name: "Local Russian", lang: "ru-RU", localService: true, default: true },
      ];
      speech.speak = (u) => {
        speech.spoken.push(u);
        speech.calls.push("speak");
      };
      speech.cancel = () => speech.calls.push("cancel");
      speech.pause = () => speech.calls.push("pause");
      speech.resume = () => speech.calls.push("resume");
      Object.defineProperty(window, "speechSynthesis", { value: speech, configurable: true });
      Object.defineProperty(window, "SpeechSynthesisUtterance", {
        value: class {
          constructor(text) {
            this.text = text;
          }
        },
        configurable: true,
      });
      window.speechMock = speech;
      const NativeAudio = window.Audio;
      window.audioTracks = [];
      window.audioErrors = [];
      window.Audio = class extends NativeAudio {
        constructor() {
          super();
          window.audioTracks.push(this);
          this.addEventListener("error", () =>
            window.audioErrors.push({ code: this.error?.code, message: this.error?.message }),
          );
        }
      };
      window.remoteConnections = 0;
      window.remoteDisconnections = 0;
      window.Guacamole = {
        WebSocketTunnel: class {},
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
    page = await context.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    let registrations = 0;
    const speechRequests = [];
    await page.route("**/api/speech/**", async (route) => {
      const url = new URL(route.request().url());
      speechRequests.push({ path: url.pathname, method: route.request().method() });
      if (url.pathname.endsWith("/status")) return route.fulfill({ json: { available: true } });
      if (route.request().method() === "POST") {
        registrations++;
        assert.equal(
          route.request().postDataJSON().text,
          "Привет. Это проверка озвучивания ответа.",
        );
        return route.fulfill({ status: 202, json: { ok: true } });
      }
      if (route.request().method() === "DELETE") return route.fulfill({ json: { ok: true } });
      return route.fulfill({ contentType: "audio/wav", body: wav });
    });
    await page.route("**/api/projects?*", async (route) => {
      const response = await route.fetch(),
        data = await response.json();
      for (const p of data.projects) p.remoteAvailable = true;
      await route.fulfill({ response, json: data });
    });
    await page.route("**/api/projects", async (route) => {
      const response = await route.fetch(),
        data = await response.json();
      for (const p of data.projects) p.remoteAvailable = true;
      await route.fulfill({ response, json: data });
    });
    let startupThreads;
    await page.route("**/api/projects/project/threads", (route) => {
      startupThreads = route;
    });
    await page.goto(origin);
    await expect.poll(() => !!startupThreads).toBe(true);
    await expect(page.getByRole("button", { name: "Обзор текущего проекта" })).toContainText(
      "Project",
    );
    assert.equal(
      f.store.preferences().threadId,
      f.thread.id,
      "Partial startup must not overwrite the selected conversation",
    );
    await startupThreads.continue();
    await page.unroute("**/api/projects/project/threads");
    const editor = page.getByRole("textbox", { name: "Сообщение Codex" });
    await expect(editor).toBeVisible();
    await editor.fill("Сохранённый черновик");
    const reply = page.locator('[data-message="audio-reply"]');
    await reply.getByRole("button", { name: "Озвучить ответ" }).tap();
    assert.equal(await page.evaluate(() => speechMock.spoken.length), 1);
    assert.equal(
      speechRequests.length,
      0,
      "default system speech must not call any speech endpoint",
    );
    assert.equal(await page.evaluate(() => audioTracks.length), 0);
    const settings = page
      .getByRole("button", { name: "Настройки", exact: true })
      .filter({ visible: true });
    await settings.click();
    await page.locator('.settings-browser[open] [data-category="sound"]').click();
    const mode = page
      .getByRole("combobox", { name: "Режим озвучивания" })
      .filter({ visible: true });
    await expect(mode).toHaveValue("system");
    await mode.selectOption("background");
    await page.getByRole("button", { name: "Закрыть настройки", exact: true }).click();
    await expect(reply.getByRole("button", { name: "Озвучить ответ" })).toBeEnabled();
    const cancelled = await page.evaluate(
      () => speechMock.calls.filter((c) => c === "cancel").length,
    );
    assert(cancelled >= 2, "changing mode releases the old system utterance");
    await reply.getByRole("button", { name: "Озвучить ответ" }).tap();
    await expect(reply.getByRole("button", { name: "Приостановить озвучивание" })).toBeVisible();
    await expect.poll(() => page.evaluate(() => audioTracks.at(-1).currentTime)).toBeGreaterThan(0);
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, value: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    assert.equal(await page.evaluate(() => audioTracks.at(-1).paused), false);
    assert.equal(registrations, 1);
    await reply.getByRole("button", { name: "Приостановить озвучивание" }).tap();
    assert.equal(await page.evaluate(() => audioTracks.at(-1).paused), true);
    await reply.getByRole("button", { name: "Продолжить озвучивание" }).tap();
    await expect.poll(() => page.evaluate(() => audioTracks.at(-1).paused)).toBe(false);
    await reply.getByRole("button", { name: "Остановить озвучивание", exact: true }).tap();
    assert.equal(await page.evaluate(() => audioTracks.at(-1).getAttribute("src")), null);
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, value: false });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await settings.click();
    await page.locator('.settings-browser[open] [data-category="sound"]').click();
    await mode.selectOption("system");
    await page.getByRole("button", { name: "Закрыть настройки", exact: true }).click();
    const beforeSystem = speechRequests.length;
    await reply.getByRole("button", { name: "Озвучить ответ" }).tap();
    await expect(reply.getByRole("button", { name: "Приостановить озвучивание" })).toBeVisible();
    assert.equal(await page.evaluate(() => audioTracks.at(-1).getAttribute("src")), null);
    assert.equal(await page.evaluate(() => speechMock.spoken.length), 2);
    assert.equal(
      speechRequests.length,
      beforeSystem,
      "explicit system mode does not contact Piper",
    );
    assert.equal(
      await page.evaluate((id) => sessionStorage.getItem("codex-draft-" + id), f.thread.id),
      "Сохранённый черновик",
    );
    await page.reload();
    await expect(editor).toHaveValue("Сохранённый черновик");
    await settings.click();
    await page.locator('.settings-browser[open] [data-category="sound"]').click();
    await expect(mode).toHaveValue("system");
    await page.screenshot({ path: `.local/qa-background-media/${engine}-speech-mode.png` });
    await page.getByRole("button", { name: "Закрыть настройки", exact: true }).click();
    await expect(page.locator(".mobile-tabs > button")).toHaveCount(2);
    assert.equal(await page.evaluate(() => remoteConnections), 0);
    for (const width of [390, 1366]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1024 });
      if (width === 390)
        await page.getByRole("button", { name: "Открыть проекты", exact: true }).tap();
      const shortcut = page
        .getByRole("button", { name: "Открыть Remote", exact: true })
        .filter({ visible: true });
      await expect(shortcut).toBeVisible();
      await shortcut.evaluate(async (el) => {
        await Promise.all(
          el
            .closest("dialog")
            ?.getAnimations({ subtree: true })
            .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
            .map((a) => a.finished.catch(() => {})) ?? [],
        );
      });
      const box = await shortcut.boundingBox();
      assert(box.width >= 44 && box.height >= 44);
      assert.equal(await shortcut.innerText(), "");
      await page.screenshot({ path: `.local/qa-background-media/${engine}-sidebar-${width}.png` });
      await shortcut.click();
      await expect(page.locator(".remote-pane")).toHaveClass(/remote-expanded.*remote-session/);
      await expect(page.getByText("Подключено", { exact: true })).toBeVisible();
      const pane = await page.locator(".remote-pane").boundingBox();
      assert(pane.width >= width - 2);
      assert(pane.height >= (width === 390 ? 844 : 1024) - 2);
      await page.screenshot({ path: `.local/qa-background-media/${engine}-remote-${width}.png` });
      await page.getByRole("button", { name: "Назад к чату", exact: true }).click();
      await expect(editor).toBeVisible();
      await expect(editor).toHaveValue("Сохранённый черновик");
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.route("**/api/gpt/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      const data = path.endsWith("/status")
        ? { configured: true, canSend: true, state: "healthy" }
        : path.endsWith("/models")
          ? { models: [], efforts: [] }
          : path.endsWith("/jobs")
            ? { items: [], stamp: 1 }
            : { items: [], conversations: [], nextOffset: null };
      return route.fulfill({ json: data });
    });
    await page.getByRole("button", { name: "Открыть проекты", exact: true }).tap();
    await page
      .getByRole("button", { name: "Переключиться на GPT" })
      .filter({ visible: true })
      .click();
    await expect(page.getByRole("textbox", { name: "Сообщение GPT" })).toBeVisible();
    await expect(page.locator(".mobile-tabs > button")).toHaveCount(2);
    await expect(page.locator(".mobile-tabs > a")).toHaveCount(0);
    await page.getByRole("button", { name: "Открыть проекты", exact: true }).tap();
    const gptRemote = page
      .getByRole("link", { name: "Открыть Remote", exact: true })
      .filter({ visible: true });
    await expect(gptRemote).toHaveAttribute("href", "/gpt-connect?immersive=1");
    assert.equal(await gptRemote.innerText(), "");
    await page.screenshot({ path: `.local/qa-background-media/${engine}-gpt-sidebar.png` });
    await page.route("**/gpt-connect**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("vendor.js"))
        return route.fulfill({
          contentType: "application/javascript",
          body: "Guacamole.Mouse=class {};Guacamole.Mouse.Touchscreen=class {};",
        });
      const file = path.endsWith("client.js")
        ? "connect-client.js"
        : path.endsWith("style.css")
          ? "connect.css"
          : "connect.html";
      return route.fulfill({
        contentType: file.endsWith("js")
          ? "application/javascript"
          : file.endsWith("css")
            ? "text/css"
            : "text/html",
        body: await readFile("ops/gpt/" + file),
      });
    });
    await gptRemote.click();
    await expect(page.locator("body")).toHaveClass("immersive");
    await expect.poll(() => page.evaluate(() => remoteConnections)).toBe(1);
    await expect(page.locator("footer")).toBeHidden();
    const area = await page.locator("#surface").boundingBox();
    assert.equal(area.width, 390);
    assert.equal(area.height, 844);
    await page.getByRole("button", { name: "Управление Remote", exact: true }).click();
    await expect(page.getByRole("button", { name: "Клавиатура", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Управление Remote", exact: true }).click();
    await expect(page.locator("footer")).toBeHidden();
    await page.screenshot({ path: `.local/qa-background-media/${engine}-gpt-remote.png` });
    await page.getByRole("link", { name: "Назад к чату", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Сообщение GPT" })).toBeVisible();
    assert.deepEqual(errors, []);
    assert.equal(f.calls.filter((c) => c.method === "turn/start").length, 0);
    assert.equal(f.desktopCalls.filter((c) => c !== "Status").length, 0);
    console.log(
      engine +
        ": real single-track playback, hidden-document continuity, pause/resume/stop; Codex/GPT icon placement and simulated full-screen auto-connect preserve draft. Physical iPhone lock is not simulated.",
    );
  } catch (error) {
    console.log("Browser fixture errors:", errors, await page.evaluate(() => window.audioErrors));
    console.log(await page.locator("body").innerText());
    throw error;
  } finally {
    await context.close();
    await browser.close();
    await f.close();
  }
}
