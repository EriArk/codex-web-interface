import { chromium, webkit, expect } from "@playwright/test";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
const origin = "http://127.0.0.1:8782", out = ".local/qa-theme-style";
const credentials = JSON.parse(await readFile(".local/qa-credentials.json", "utf8"));
await mkdir(out, { recursive: true });
const report = [];
for (const [engine, type] of [["chromium", chromium], ["webkit", webkit]]) {
  const browser = await type.launch({ headless: true, ...(engine === "chromium" ? { args: ["--no-sandbox"] } : {}) });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: "block" });
    const page = await context.newPage(), errors = [], remoteRequests = [];
    page.on("pageerror", e => errors.push(e.message));
    page.on("request", r => { if (new URL(r.url()).origin !== origin) remoteRequests.push(r.url()); });
    const setup = (await (await context.request.get(origin + "/api/auth/status")).json()).requiresSetup;
    await page.goto(origin + (setup ? "/#setup=" + credentials.setupToken : "/"));
    await page.getByLabel(setup ? "Придумай пароль" : "Пароль", { exact: true }).fill(credentials.password);
    if (setup) await page.getByLabel("Повтори пароль", { exact: true }).fill(credentials.password);
    await page.getByRole("button", { name: setup ? "Сохранить и войти" : "Войти", exact: true }).tap();
    await page.locator(".workspace").waitFor();
    const openSettings = async () => { await page.locator('button[aria-label="Настройки"]').tap(); await page.locator(".settings-dialog[open]").waitFor(); };
    const closeSettings = () => page.getByRole("button", { name: "Закрыть настройки", exact: true }).tap();
    const nav = page.getByRole("navigation", { name: "Разделы рабочего пространства" });
    await nav.getByRole("button", { name: "Чат", exact: true }).tap();
    await page.getByRole("textbox", { name: "Сообщение Codex" }).waitFor();
    const draft = "Сделай интерфейс ещё аккуратнее";
    await page.getByRole("textbox", { name: "Сообщение Codex" }).fill(draft);
    const shot = async (theme, screen) => {
      await page.evaluate(() => document.fonts.ready.then(() => true));
      await expect.poll(() => page.locator(".workspace").evaluate(el => Math.round(el.getBoundingClientRect().height))).toBe(page.viewportSize().height);
      await page.waitForTimeout(100);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, theme + " overflow");
      const path = out + "/" + engine + "-" + theme + "-" + screen + ".png";
      await page.screenshot({ path });
      report.push({ engine, theme, screen, ...page.viewportSize(), path });
    };
    for (const theme of ["crt-green", "classic-dark", "organizer", "hitech-2000s"]) {
      console.log(engine + " " + theme);
      await openSettings();
      assert.equal(await page.locator('input[name="theme"]').count(), 4);
      if (!(await page.locator(".theme-option." + theme + " input").isChecked())) {
        const saved = page.waitForResponse(r => r.url().endsWith("/api/preferences") && r.request().method() === "PATCH" && r.request().postDataJSON()?.theme === theme);
        await page.locator(".theme-option." + theme).tap();
        assert.equal((await saved).status(), 200);
      }
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await shot(theme, "settings");
      await closeSettings();
      if (theme === "crt-green") {
        const font = await page.evaluate(async () => {
          const loaded = await document.fonts.load('14px "IBM Plex Mono"', "Привет, Codex! 012345");
          const style = getComputedStyle(document.querySelector(".message-body"));
          return { loaded: loaded.length, family: style.fontFamily, shadow: style.textShadow };
        });
        assert(font.loaded > 0 && font.family.includes("IBM Plex Mono") && font.shadow !== "none");
      }
      for (const [width, height] of [[390, 844], [375, 667], [844, 390], [820, 1180], [1366, 1024]]) {
        await page.setViewportSize({ width, height });
        await expect(page.locator(".composer")).toBeVisible();
        await shot(theme, "chat-" + width + "x" + height);
        const box = await page.locator(".composer").boundingBox();
        assert(box && box.x >= 0 && box.x + box.width <= width + 1 && box.y + box.height <= height + 1, "composer fits " + theme);
      }
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByRole("button", { name: "Открыть проекты", exact: true }).tap();
      await shot(theme, "projects");
      await page.getByRole("button", { name: "Закрыть проекты", exact: true }).tap();
      await nav.getByRole("button", { name: /Результаты/ }).tap();
      await shot(theme, "results");
      await page.getByRole("button", { name: "Открыть снимок", exact: true }).first().tap();
      await shot(theme, "image");
      assert.equal(await page.locator(".image-viewer img").evaluate(el => getComputedStyle(el).filter), "none");
      await page.getByRole("button", { name: "Закрыть снимок", exact: true }).tap();
      await nav.getByRole("button", { name: "Remote", exact: true }).tap();
      await shot(theme, "remote-idle");
      if (["crt-green", "classic-dark", "hitech-2000s", "organizer"].includes(theme)) {
        // Local fixture only: no connection or input to the owner's desktop.
        await page.addScriptTag({ url: origin + "/vendor/guacamole-1.6.0.min.js" });
        await page.evaluate(() => {
          const G = window.Guacamole, Original = G.Client;
          G.Client = Object.assign(function () {
            const canvas = document.createElement("canvas"); canvas.width = 1920; canvas.height = 1080;
            const ctx = canvas.getContext("2d");
            ctx.fillStyle = "#224b78"; ctx.fillRect(0, 0, 1920, 1080);
            ctx.fillStyle = "#fa9d55"; ctx.fillRect(180, 160, 1560, 760);
            ctx.fillStyle = "#141b29"; ctx.font = "48px sans-serif"; ctx.fillText("Remote — original colors", 260, 300);
            const display = { getElement: () => canvas, getWidth: () => 1920, getHeight: () => 1080,
              scale: v => { canvas.style.transformOrigin = "0 0"; canvas.style.transform = "scale(" + v + ")"; },
              showCursor: () => {}, flatten: () => canvas, flush: cb => cb() };
            const client = { getDisplay: () => display, sendMouseState: () => {}, sendKeyEvent: () => {},
              connect: () => queueMicrotask(() => { client.onstatechange?.(3); display.onresize?.(); client.onsync?.(); }),
              disconnect: () => client.onstatechange?.(5) };
            return client;
          }, Original);
        });
        await page.getByRole("button", { name: "Подключиться", exact: true }).tap();
        await expect(page.locator(".remote-display")).toHaveAttribute("data-ready", "true");
        await shot(theme, "remote-connected");
        await page.setViewportSize({ width: 844, height: 390 });
        await shot(theme, "remote-landscape");
        const remoteBox = await page.locator(".remote-display").boundingBox();
        assert.equal(Math.round(remoteBox.height), 390);
        assert.equal(Math.round(remoteBox.width), 844);
        assert.equal(await page.locator(".remote-display canvas").evaluate(el => getComputedStyle(el).filter), "none");
        await page.getByRole("button", { name: "Назад к чату", exact: true }).tap();
        await page.setViewportSize({ width: 390, height: 844 });
        await openSettings();
        await page.getByRole("button", { name: "Активность диалога", exact: true }).tap();
        await shot(theme, "activity");
      }

      await nav.getByRole("button", { name: "Чат", exact: true }).tap();
      await page.reload(); await page.locator(".workspace").waitFor();
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      const preferences = await (await context.request.get(origin + "/api/preferences")).json();
      assert.equal(preferences.theme, theme);
      await expect(page.getByRole("textbox", { name: "Сообщение Codex" })).toHaveValue(draft);
    }
    await openSettings(); await page.locator(".theme-option.crt-green").tap(); await closeSettings();
    await page.emulateMedia({ contrast: "more", reducedMotion: "reduce" });
    await expect(page.locator(".message-body").last()).toHaveCSS("text-shadow", "none");
    await shot("crt-green", "increased-contrast");
    for (const theme of ["crt-green", "classic-dark"]) {
      const loggedOut = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: "block" });
      await loggedOut.addInitScript(value => localStorage.setItem("codex-theme", value), theme);
      const loginPage = await loggedOut.newPage(); await loginPage.goto(origin);
      await loginPage.getByLabel("Пароль", { exact: true }).waitFor();
      await expect(loginPage.locator("html")).toHaveAttribute("data-theme", theme);
      await loginPage.screenshot({ path: out + "/" + engine + "-" + theme + "-login.png" });
      assert.notEqual(await loginPage.locator('meta[name="theme-color"]').getAttribute("content"), "#f4f2eb");
      await loggedOut.close();
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(remoteRequests, [], "fonts and assets stay on the Hub");
    await context.close();
  } finally { await browser.close(); }
}
await writeFile(out + "/report.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify({ screenshots: report.length + 4, engines: ["chromium", "webkit"], themes: 4, preferencePersistence: true, fontsLocal: true, highContrast: true }));
