import { chromium, webkit, expect } from "@playwright/test";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import assert from "node:assert/strict";
const credentials = JSON.parse(await readFile(".local/qa-credentials.json", "utf8")),
  origin = "http://127.0.0.1:8782";
const report = [];
for (const [engine, type] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
  console.log("Checking Remote keyboard in " + engine);
  const browser = await type.launch({
    headless: true,
    ...(engine === "chromium" ? { args: ["--no-sandbox"] } : {}),
  });
  try {
    const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      }),
      page = await context.newPage(),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const setup = (await (await context.request.get(origin + "/api/auth/status")).json())
      .requiresSetup;
    await page.goto(origin + (setup ? "/#setup=" + credentials.setupToken : "/"));
    await page
      .getByLabel(setup ? "Придумай пароль" : "Пароль", { exact: true })
      .fill(credentials.password);
    if (setup) await page.getByLabel("Повтори пароль", { exact: true }).fill(credentials.password);
    await page
      .getByRole("button", { name: setup ? "Сохранить и войти" : "Войти", exact: true })
      .click();
    await page.locator(".workspace").waitFor();
    await page.addScriptTag({ url: origin + "/vendor/guacamole-1.6.0.min.js" });
    await page.evaluate(() => {
      window.keyboardCheck = { keys: [], focus: [], inClick: false, events: [] };
      for (const name of [
        "pointerdown",
        "pointerup",
        "touchstart",
        "touchend",
        "click",
        "focus",
        "blur",
      ])
        document.addEventListener(
          name,
          (e) => {
            if (e.target.closest(".remote-pane"))
              window.keyboardCheck.events.push({
                type: e.type,
                target: e.target.getAttribute("aria-label") || e.target.tagName,
                prevented: e.defaultPrevented,
              });
          },
          true,
        );
      const G = window.Guacamole,
        Original = G.Client;
      // Exercise the actual Guacamole keyboard with a simulated display/transport.
      // Keyboard regression checks must never type into the owner's live Windows desktop.
      G.Client = Object.assign(function () {
        const canvas = document.createElement("canvas");
        canvas.width = 1920;
        canvas.height = 1080;
        canvas.getContext("2d").fillRect(0, 0, canvas.width, canvas.height);
        const display = {
          getElement: () => canvas,
          getWidth: () => canvas.width,
          getHeight: () => canvas.height,
          scale: (value) => {
            canvas.style.transformOrigin = "0 0";
            canvas.style.transform = "scale(" + value + ")";
          },
          showCursor: () => {},
          flatten: () => canvas,
          flush: (callback) => callback(),
        };
        const client = {
          getDisplay: () => display,
          sendMouseState: () => {},
          sendKeyEvent: (pressed, keysym) => window.keyboardCheck.keys.push({ pressed, keysym }),
          connect: () =>
            queueMicrotask(() => {
              client.onstatechange?.(3);
              display.onresize?.();
              client.onsync?.();
            }),
          disconnect: () => client.onstatechange?.(5),
        };
        return client;
      }, Original);
      document.addEventListener(
        "click",
        (e) => {
          if (
            e.target.closest(
              'button[aria-label="Открыть клавиатуру"],button[aria-label="Скрыть клавиатуру"]',
            )
          ) {
            window.keyboardCheck.inClick = true;
            setTimeout(() => (window.keyboardCheck.inClick = false), 0);
          }
        },
        true,
      );
      const focus = HTMLTextAreaElement.prototype.focus;
      HTMLTextAreaElement.prototype.focus = function (...args) {
        if (this.getAttribute("aria-label") === "Клавиатура удалённого рабочего стола")
          window.keyboardCheck.focus.push({
            synchronous: window.keyboardCheck.inClick,
            width: this.getBoundingClientRect().width,
            height: this.getBoundingClientRect().height,
          });
        return focus.apply(this, args);
      };
    });
    const open = async () => {
      await page
        .getByRole("navigation", { name: "Разделы рабочего пространства" })
        .getByRole("button", { name: "Remote", exact: true })
        .tap();
      await page.getByRole("button", { name: "Подключиться", exact: true }).tap();
      await expect(page.locator(".remote-display")).toHaveAttribute("data-ready", "true", {
        timeout: 25000,
      });
      await page.getByRole("button", { name: "Открыть клавиатуру", exact: true }).tap();
      try {
        await expect(
          page.getByLabel("Клавиатура удалённого рабочего стола", { exact: true }),
        ).toBeFocused();
      } catch (error) {
        console.log(
          JSON.stringify(
            await page.evaluate(() => ({
              check: window.keyboardCheck,
              active: document.activeElement?.tagName,
            })),
            null,
            2,
          ),
        );
        throw error;
      }
      await expect(
        page.getByRole("button", { name: "Скрыть клавиатуру", exact: true }),
      ).toHaveAttribute("aria-pressed", "true");
    };
    const checkKeys = async (text, action) => {
      await page.evaluate(() => (window.keyboardCheck.keys = []));
      await action();
      const keys = await page.evaluate(() => window.keyboardCheck.keys);
      const expected = Array.from(text).flatMap((c) => {
        const cp = c.codePointAt(0),
          keysym =
            cp <= 31 || (cp >= 127 && cp <= 159) ? 0xff00 | cp : cp <= 255 ? cp : 0x01000000 | cp;
        return [
          { pressed: 1, keysym },
          { pressed: 0, keysym },
        ];
      });
      assert.deepEqual(keys, expected, "Text must reach Remote once: " + text);
    };
    await open();
    const focused = await page.evaluate(() => window.keyboardCheck.focus[0]);
    assert(
      focused.synchronous,
      "iOS focus must occur in the original button tap, before any deferred callback",
    );
    assert(focused.width > 0 && focused.height > 0, "iOS input must have nonzero geometry");
    await checkKeys("я", () => page.keyboard.insertText("я"));
    await checkKeys("拼", async () => {
      await page.evaluate(() => {
        const field = document.querySelector(".remote-keyboard-input");
        field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
        field.dispatchEvent(
          new InputEvent("input", {
            bubbles: true,
            data: "拼",
            isComposing: true,
            inputType: "insertCompositionText",
          }),
        );
        field.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "拼" }));
        field.dispatchEvent(
          new InputEvent("input", {
            bubbles: true,
            data: "拼",
            isComposing: false,
            inputType: "insertFromComposition",
          }),
        );
      });
    });
    await checkKeys("A", () => page.keyboard.insertText("A"));
    await checkKeys("\b\r", async () => {
      await page.keyboard.press("Backspace");
      await page.keyboard.press("Enter");
    });
    await page.getByRole("button", { name: "Скрыть клавиатуру", exact: true }).tap();
    await expect(
      page.getByLabel("Клавиатура удалённого рабочего стола", { exact: true }),
    ).not.toBeFocused();
    await page.getByRole("button", { name: "Назад к чату", exact: true }).tap();
    await page
      .getByRole("navigation", { name: "Разделы рабочего пространства" })
      .getByRole("button", { name: "Чат", exact: true })
      .tap();
    await expect(page.getByRole("textbox", { name: "Сообщение Codex" })).toBeVisible();
    await page.evaluate(() => (window.keyboardCheck.keys = []));
    await page.getByRole("textbox", { name: "Сообщение Codex" }).tap();
    await page.keyboard.insertText("Локальный черновик");
    assert.deepEqual(
      await page.evaluate(() => window.keyboardCheck.keys),
      [],
      "Chat typing must not reach Remote",
    );
    await open();
    await checkKeys("Z", () => page.keyboard.insertText("Z"));
    await page.setViewportSize({ width: 844, height: 390 });
    await expect(
      page.getByLabel("Клавиатура удалённого рабочего стола", { exact: true }),
    ).toBeFocused();
    const area = await page.locator(".remote-display").boundingBox();
    assert(area.height >= 380);
    await page.getByRole("button", { name: "Скрыть клавиатуру", exact: true }).tap();
    await page.getByRole("button", { name: "Назад к чату", exact: true }).tap();
    assert.deepEqual(errors, []);
    report.push({
      engine,
      synchronousTapFocus: true,
      nonzeroInput: true,
      russianInput: true,
      composition: true,
      inputAfterComposition: true,
      backspaceAndEnter: true,
      chatInputIsolated: true,
      reconnectWithoutDuplicateKeys: true,
      landscape: true,
      physicalIOSKeyboard: false,
      simulatedRemoteTransport: true,
      remoteKeystrokesIntercepted: true,
    });
    await context.close();
  } finally {
    await browser.close();
  }
}
await mkdir(".local/qa-keyboard", { recursive: true });
await writeFile(".local/qa-keyboard/report.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
