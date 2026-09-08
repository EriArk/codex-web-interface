import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, expect, webkit } from "@playwright/test";
import { handoffFixture } from "./handoff-fixture.mjs";

await mkdir(".local/qa-speech", { recursive: true });
for (const [engine, type] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
  const origin = "http://127.0.0.1:18858",
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
  f.store.append(f.thread.id, "user.message", { id: "user", text: "Проверить ответ" });
  f.store.append(f.thread.id, "assistant.completed", {
    id: "speech-a",
    phase: "commentary",
    text:
      "**Проверяю** [ссылку](https://example.test/private).\n\n" +
      "Длинный ответ продолжается. ".repeat(30) +
      "\n\n```js\nне произносить код\n```",
  });
  f.store.append(f.thread.id, "assistant.completed", {
    id: "speech-b",
    text: "Второй ответ. Выбор одного сообщения.",
  });
  const browser = await type.launch(),
    context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      serviceWorkers: "block",
    });
  try {
    await f.app.listen({ port: 18858, host: "127.0.0.1" });
    const [name, value] = f.headers.cookie.split("=");
    await context.addCookies([{ name, value, url: origin, httpOnly: true, sameSite: "Strict" }]);
    await context.addInitScript(() => {
      const speech = new EventTarget();
      speech.voices = [];
      speech.calls = [];
      speech.spoken = [];
      speech.getVoices = () => speech.voices;
      speech.speak = (utterance) => {
        speech.spoken.push(utterance);
        speech.calls.push("speak");
      };
      speech.pause = () => speech.calls.push("pause");
      speech.resume = () => speech.calls.push("resume");
      speech.cancel = () => speech.calls.push("cancel");
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
    });
    const page = await context.newPage(),
      errors = [],
      unexpected = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("request", (request) => {
      if (!request.url().startsWith(origin)) unexpected.push(request.url());
    });
    await page.goto(origin);
    const editor = page.getByRole("textbox", { name: "Сообщение Codex" });
    await expect(editor).toBeVisible();
    await editor.fill("Черновик не меняется");
    const a = page.locator('[data-message="speech-a"]'),
      b = page.locator('[data-message="speech-b"]');
    await expect(a.getByRole("button", { name: "Озвучить ответ" })).toBeDisabled();
    await page.evaluate(() => {
      speechMock.voices = [
        { name: "System Russian", lang: "ru-RU", default: true, localService: true },
      ];
      speechMock.dispatchEvent(new Event("voiceschanged"));
    });
    await a.getByRole("button", { name: "Озвучить ответ" }).tap();
    await expect(a.getByRole("button", { name: "Приостановить озвучивание" })).toBeVisible();
    assert.equal(await page.evaluate(() => speechMock.spoken.length), 1);
    assert.equal(await page.evaluate(() => speechMock.spoken[0].text), "Проверяю ссылку.");
    await a.getByRole("button", { name: "Приостановить озвучивание" }).tap();
    await expect(a.getByRole("button", { name: "Продолжить озвучивание" })).toBeVisible();
    await a.getByRole("button", { name: "Продолжить озвучивание" }).tap();
    assert.equal(await page.evaluate(() => speechMock.spoken.length), 1);
    await page.evaluate(() => speechMock.spoken[0].onend());
    assert.equal(await page.evaluate(() => speechMock.spoken.length), 2);
    await b.getByRole("button", { name: "Озвучить ответ" }).tap();
    await page.evaluate(() => {
      speechMock.spoken[1].onend();
      speechMock.spoken[1].onerror();
    });
    assert.equal(await page.evaluate(() => speechMock.spoken.length), 3);
    await expect(a.getByRole("button", { name: "Озвучить ответ" })).toBeVisible();
    await expect(
      b.getByRole("button", { name: "Остановить озвучивание", exact: true }),
    ).toBeVisible();
    await b.getByRole("button", { name: "Остановить озвучивание", exact: true }).tap();
    await expect(b.getByRole("button", { name: "Озвучить ответ" })).toBeVisible();
    assert.equal(await page.locator(".message.user .speech-control").count(), 0);
    await a.getByRole("button", { name: "Озвучить ответ" }).tap();
    for (const theme of ["crt-green", "organizer", "hitech-2000s", "classic-dark"]) {
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
      }, theme);
      for (const width of [390, 1366]) {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 1024 });
        await a.scrollIntoViewIfNeeded();
        for (const button of await a.locator(".message-actions button").all()) {
          const box = await button.boundingBox();
          assert(box.width >= 44 && box.height >= 44);
          assert(box.x >= 0 && box.x + box.width <= width);
        }
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        if (engine === "chromium")
          await a.screenshot({ path: `.local/qa-speech/${theme}-${width}.png` });
      }
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Обзор текущего проекта" }).tap();
    await page
      .getByRole("button", { name: /^Handoff chat/ })
      .filter({ visible: true })
      .first()
      .click();
    await expect(a.getByRole("button", { name: "Озвучить ответ" })).toBeVisible();
    await expect(editor).toHaveValue("Черновик не меняется");
    await a.getByRole("button", { name: "Озвучить ответ" }).tap();
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide")));
    await expect(a.getByRole("button", { name: "Озвучить ответ" })).toBeVisible();
    // Actual GPT workspace with normalized cached history, no native service involved.
    await page.route("**/api/gpt/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      let data = { items: [], conversations: [], nextOffset: null };
      if (path.endsWith("/status")) data = { configured: true, canSend: true, state: "healthy" };
      else if (path.endsWith("/models")) data = { models: [], efforts: [] };
      else if (path.endsWith("/jobs")) data = { items: [], stamp: 1 };
      else if (path.endsWith("/conversations"))
        data = { items: [{ id: "speech-gpt", title: "Озвучивание GPT" }], nextOffset: null };
      else if (path.endsWith("/messages"))
        data = {
          items: [
            { id: "g-user", role: "user", text: "Запрос", files: [], createdAt: 1 },
            {
              id: "g-answer",
              role: "assistant",
              text: "Ответ GPT без отправки нового сообщения.",
              files: [],
              createdAt: 2,
            },
          ],
          nextBefore: null,
          revision: "1",
          prefix: "1",
        };
      await route.fulfill({ json: data });
    });
    await page.getByRole("button", { name: "Открыть проекты", exact: true }).tap();
    await page
      .getByRole("combobox", { name: "Режим приложения" })
      .filter({ visible: true })
      .selectOption("gpt");
    await expect(page.getByRole("textbox", { name: "Сообщение GPT" })).toBeVisible();
    await page.getByRole("button", { name: "Открыть проекты", exact: true }).tap();
    await page
      .getByRole("button", { name: "Озвучивание GPT", exact: true })
      .filter({ visible: true })
      .click();
    const gpt = page.locator(".gpt-chat .message.assistant");
    await gpt.getByRole("button", { name: "Озвучить ответ" }).tap();
    await expect(gpt.getByRole("button", { name: "Приостановить озвучивание" })).toBeVisible();
    assert.equal(
      await page.evaluate(() => speechMock.spoken.at(-1).text),
      "Ответ GPT без отправки нового сообщения.",
    );
    await page.getByRole("button", { name: "Открыть проекты", exact: true }).tap();
    await expect(gpt.getByRole("button", { name: "Озвучить ответ" })).toBeAttached();
    await page
      .getByRole("combobox", { name: "Режим приложения" })
      .filter({ visible: true })
      .selectOption("codex");
    assert.equal(
      await page.getByRole("button", { name: "Остановить озвучивание", exact: true }).count(),
      0,
    );
    await page.addInitScript(() => {
      Object.defineProperty(window, "speechSynthesis", { value: undefined, configurable: true });
      Object.defineProperty(window, "SpeechSynthesisUtterance", {
        value: undefined,
        configurable: true,
      });
    });
    await page.reload();
    await expect(editor).toBeVisible();
    await expect(a.getByRole("button", { name: "Копировать сообщение" })).toBeVisible();
    assert.equal(await page.locator(".speech-control").count(), 0);
    assert.deepEqual(unexpected, []);
    assert.deepEqual(errors, []);
    assert.equal(f.calls.filter((c) => c.method === "turn/start").length, 0);
    assert.equal(f.desktopCalls.filter((c) => c !== "Status").length, 0);
    console.log(
      engine +
        ": real Codex/GPT controls, mocked system voices, pause/resume/stop, chunking, cancel races, navigation, drafts and four themes passed",
    );
  } finally {
    await context.close();
    await browser.close();
    await f.close();
  }
}
