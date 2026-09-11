import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, expect, webkit } from "@playwright/test";
import { handoffFixture } from "./handoff-fixture.mjs";

for (const [engine, type] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
  const origin = "http://127.0.0.1:18933";
  let finish,
    calls = 0;
  const f = await handoffFixture(origin, undefined, {
    transcribe: async () => {
      calls++;
      return new Promise((resolve, reject) => {
        finish = { resolve, reject };
      });
    },
  });
  f.store.setPreferences({
    projectId: "project",
    threadId: f.thread.id,
    view: "chat",
    machineClients: { pc: "web" },
    theme: "crt-green",
  });
  const browser = await type.launch();
  await f.app.listen({ port: 18933, host: "127.0.0.1" });
  try {
    for (const client of ["codex", "gpt"]) {
      const context = await browser.newContext({
        viewport: { width: 393, height: 852 },
        hasTouch: true,
        serviceWorkers: "block",
        reducedMotion: "reduce",
      });
      const [name, value] = f.headers.cookie.split("=");
      await context.addCookies([{ name, value, url: origin, httpOnly: true, sameSite: "Strict" }]);
      await context.addInitScript((client) => {
        localStorage.setItem("codex-client", client);
        window.mic = { stops: 0, late: false, grant: null };
        const microphone = () => ({
          getTracks: () => [
            {
              stop() {
                window.mic.stops++;
              },
            },
          ],
        });
        Object.defineProperty(navigator, "mediaDevices", {
          configurable: true,
          value: {
            getUserMedia: async () =>
              window.mic.late
                ? new Promise((resolve) => {
                    window.mic.grant = () => resolve(microphone());
                  })
                : microphone(),
          },
        });
        window.MediaRecorder = class {
          state = "inactive";
          static isTypeSupported(type) {
            return type === "audio/mp4";
          }
          start() {
            this.state = "recording";
          }
          stop() {
            if (this.state === "inactive") throw Error("Double stop");
            this.state = "inactive";
            queueMicrotask(() => {
              this.ondataavailable?.({
                data: new Blob(["synthetic recorded audio"], { type: "audio/mp4" }),
              });
              this.onstop?.();
            });
          }
        };
      }, client);
      const page = await context.newPage(),
        errors = [];
      page.on("pageerror", (e) => errors.push(e.message));

      await page.route("**/api/gpt/**", (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === "/api/gpt/status")
          return route.fulfill({ json: { configured: true, canSend: true, state: "healthy" } });
        if (path === "/api/gpt/models")
          return route.fulfill({
            json: {
              models: [{ id: "Latest", label: "Latest" }],
              efforts: [{ id: "2", label: "High" }],
              currentModel: "Latest",
              currentEffort: "2",
            },
          });
        if (path === "/api/gpt/send") throw Error("Dictation must never submit a chat");
        return route.fulfill({ json: { items: [], conversations: [], nextOffset: null } });
      });
      try {
        await page.goto(origin);
        const draft = page.getByRole("textbox", {
          name: client === "codex" ? "Сообщение Codex" : "Сообщение GPT",
        });
        const button = (name) =>
          page.getByRole("button", { name, exact: true }).filter({ visible: true }).first();
        const mic = button("Продиктовать сообщение"),
          panel = page.getByRole("region", { name: "Диктовка сообщения" });
        await expect(mic).toBeVisible();
        await draft.fill("Написано руками");
        const before = calls;
        await mic.click();
        await expect(panel).toContainText("Запись 0:");
        await button("Готово").click();
        await expect.poll(() => calls).toBe(before + 1);
        await expect(panel).toContainText("Распознаю");
        await draft.fill("Отредактированный черновик");
        finish.resolve("Распознанная фраза");
        await expect(draft).toHaveValue("Отредактированный черновик\nРаспознанная фраза");
        await expect(panel).toHaveCount(0);
        assert.equal(calls, before + 1);
        assert((await page.evaluate(() => window.mic.stops)) > 0);

        // Lost HTTP acknowledgement: explicit retry uses the same audio receipt.
        let lost = true;
        await page.route("**/api/dictation/*", async (route) => {
          if (lost && route.request().method() === "POST") {
            lost = false;
            const response = await route.fetch({
              postData: Buffer.from("synthetic recorded audio"),
            });
            assert.equal(response.status(), 202);
            return route.abort("failed");
          }
          return route.continue();
        });
        await mic.click();
        await button("Готово").click();
        await expect(button("Повторить")).toBeVisible();
        finish.resolve("Без дубля");
        await button("Повторить").evaluate((b) => {
          b.click();
          b.click();
        });
        await expect(draft).toHaveValue(
          "Отредактированный черновик\nРаспознанная фраза\nБез дубля",
        );
        assert.equal(calls, before + 2);
        await page.unroute("**/api/dictation/*");

        await mic.click();
        await button("Готово").click();
        await expect.poll(() => calls).toBe(before + 3);
        finish.reject(Error("Private provider diagnostic"));
        await expect(button("Повторить")).toBeVisible();
        await expect(panel).not.toContainText("Private provider");
        await button("Повторить").click();
        await expect.poll(() => calls).toBe(before + 4);
        finish.resolve("После повтора");
        await expect(draft).toHaveValue(/После повтора$/);

        await mic.click();
        await button("Готово").click();
        await expect.poll(() => calls).toBe(before + 5);
        const saved = await draft.inputValue();
        await button("Отменить диктовку").click();
        finish.resolve("Не должен попасть");
        await expect(panel).toHaveCount(0);
        await expect(draft).toHaveValue(saved);

        await page.evaluate(() => {
          window.mic.late = true;
        });
        await mic.click();
        await expect(panel).toContainText("Доступ к микрофону");
        await button("Отменить диктовку").click();
        const stopped = await page.evaluate(() => window.mic.stops);
        await page.evaluate(() => window.mic.grant());
        await expect.poll(() => page.evaluate(() => window.mic.stops)).toBeGreaterThan(stopped);
        assert.equal(calls, before + 5);
        await page.evaluate(() => {
          window.mic.late = false;
        });

        await page.setViewportSize({ width: 1366, height: 1024 });
        await mic.click();
        await button("Готово").click();
        await expect.poll(() => calls).toBe(before + 6);
        await button(
          client === "codex" ? "Переключиться на GPT" : "Переключиться на Codex",
        ).click();
        finish.resolve("Запоздалый текст из другого режима");
        const otherDraft = page.getByRole("textbox", {
          name: client === "codex" ? "Сообщение GPT" : "Сообщение Codex",
        });
        await expect(otherDraft).toBeVisible();
        await expect(otherDraft).not.toHaveValue(/Запоздалый/);
        await button(
          client === "codex" ? "Переключиться на Codex" : "Переключиться на GPT",
        ).click();
        await expect(draft).toHaveValue(saved);

        await mkdir(`.local/qa-dictation/${engine}`, { recursive: true });
        for (const width of [393, 1366]) {
          await page.setViewportSize({ width, height: width === 393 ? 852 : 1024 });
          for (const theme of ["crt-green", "hitech-2000s", "organizer", "classic-dark"]) {
            await page.evaluate((theme) => {
              document.documentElement.dataset.theme = theme;
            }, theme);
            await mic.click();
            await expect(panel).toContainText("Запись");
            assert((await mic.boundingBox()).width >= 44);
            assert((await mic.boundingBox()).height >= 44);
            assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
            await page.screenshot({
              path: `.local/qa-dictation/${engine}/${client}-${theme}-${width}.png`,
            });
            await button("Отменить диктовку").click();
          }
        }
        assert.deepEqual(errors, []);
        assert(!f.calls.some((c) => ["turn/start", "turn/steer"].includes(c.method)));
        console.log(
          `${engine}/${client}: draft-only dictation, editing, lost acknowledgement, retry, cancel, late permission, 4 themes and phone/tablet passed`,
        );
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
    await f.close();
  }
}
