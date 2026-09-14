import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, expect, webkit } from "@playwright/test";
import { handoffFixture } from "./handoff-fixture.mjs";

for (const [engine, type] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
  const origin = "http://127.0.0.1:18933",
    f = await handoffFixture(origin);
  f.store.setPreferences({
    projectId: "project",
    threadId: f.thread.id,
    view: "chat",
    theme: "hitech-2000s",
  });
  const browser = await type.launch(),
    context = await browser.newContext({
      viewport: { width: 393, height: 852 },
      hasTouch: true,
      reducedMotion: "reduce",
      serviceWorkers: "block",
    });
  try {
    await f.app.listen({ port: 18933, host: "127.0.0.1" });
    const [name, value] = f.headers.cookie.split("=");
    await context.addCookies([{ name, value, url: origin, httpOnly: true }]);
    const page = await context.newPage(),
      errors = [],
      reads = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("request", (r) => {
      if (r.method() === "GET") reads.push(new URL(r.url()).pathname);
    });
    await page.route("**/api/gpt/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/gpt/status")
        return route.fulfill({
          json: { configured: true, canSend: true, state: "healthy", message: "ChatGPT подключён" },
        });
      if (path === "/api/gpt/models")
        return route.fulfill({
          json: {
            models: [{ id: "Latest", label: "Latest" }],
            efforts: [{ id: "2", label: "High" }],
            currentModel: "Latest",
            currentEffort: "2",
          },
        });
      return route.fulfill({
        json: { items: [], conversations: [], nextOffset: null, blocked: false },
      });
    });
    await page.goto(origin);
    const button = (name) =>
      page.getByRole("button", { name, exact: true }).filter({ visible: true }).first();
    const openSettings = async () => {
      if (!(await button("Настройки").isVisible())) await button("Открыть проекты").click();
      await button("Настройки").click();
    };
    const settings = page.getByRole("dialog", { name: "Настройки", exact: true });
    const choose = async (id) => {
      if (!(await settings.locator(".settings-categories").isVisible()))
        await button("Все категории настроек").click();
      await settings.locator(`[data-category="${id}"]`).click();
    };
    const codex = page.getByRole("textbox", { name: "Сообщение Codex" });
    await codex.fill("Не терять мой черновик");
    await codex.blur();
    await openSettings();
    await expect(settings.locator(".settings-categories button")).toHaveCount(6);
    assert(
      !reads.some((path) => /\/storage\/?$|\/bridge-doctor$/.test(path)),
      "Opening the index must not start hidden settings probes",
    );
    await expect(settings.locator(".settings-usage-summary .usage-limits")).toBeVisible();
    await choose("access");
    await button("Сменить пароль").click();
    await settings.getByLabel("Текущий пароль", { exact: true }).fill("Unsaved example");
    await choose("sound");
    await expect(settings.getByLabel("Режим озвучивания")).toBeVisible();
    await choose("access");
    await expect(settings.getByLabel("Текущий пароль", { exact: true })).toHaveValue(
      "Unsaved example",
    );
    // Standalone phone safe areas differ in portrait and landscape.
    for (const [width, height, top, side, bottom] of [
      [393, 852, 59, 0, 34],
      [844, 390, 0, 59, 21],
    ]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(
        ({ top, side, bottom }) => {
          for (const [key, value] of Object.entries({ top, left: side, right: side, bottom }))
            document.documentElement.style.setProperty(`--safe-${key}`, `${value}px`);
        },
        { top, side, bottom },
      );
      await expect
        .poll(async () => {
          const r = await settings.boundingBox();
          return (
            r.y >= top &&
            r.y + r.height <= height - bottom + 1 &&
            r.x >= side &&
            r.x + r.width <= width - side + 1
          );
        })
        .toBe(true);
    }
    await page.setViewportSize({ width: 393, height: 852 });
    await page.evaluate(() => {
      for (const key of ["top", "bottom", "left", "right"])
        document.documentElement.style.removeProperty(`--safe-${key}`);
    });
    // The software keyboard can pan the visual viewport independently of the layout viewport.
    for (const offset of [0, 180]) {
      await page.evaluate((offset) => {
        document.documentElement.style.setProperty("--safe-top", "59px");
        Object.defineProperty(visualViewport, "height", { configurable: true, get: () => 340 });
        Object.defineProperty(visualViewport, "offsetTop", {
          configurable: true,
          get: () => offset,
        });
        visualViewport.dispatchEvent(new Event("resize"));
      }, offset);
      await expect
        .poll(async () => {
          const r = await settings.boundingBox(),
            close = await button("Закрыть настройки").boundingBox();
          return (
            r.y >= Math.max(59, offset) &&
            r.y + r.height <= offset + 341 &&
            close.y >= Math.max(59, offset) &&
            close.y + close.height <= offset + 340
          );
        })
        .toBe(true);
    }
    await page.evaluate(() => {
      document.documentElement.style.removeProperty("--safe-top");
      delete visualViewport.height;
      delete visualViewport.offsetTop;
      visualViewport.dispatchEvent(new Event("resize"));
    });
    await settings.getByLabel("Текущий пароль", { exact: true }).fill("");
    await button("Закрыть настройки").click();
    await expect(codex).toHaveValue("Не терять мой черновик");
    await mkdir(`.local/qa-settings/${engine}`, { recursive: true });
    for (const client of ["Codex", "GPT"]) {
      if (client === "GPT") {
        await page.setViewportSize({ width: 1366, height: 1024 });
        await button("Переключиться на GPT").click();
        await page.getByRole("textbox", { name: "Сообщение GPT" }).fill("Черновик GPT");
      }
      await openSettings();
      await expect(settings.locator(".settings-usage-summary .usage-limits")).toBeVisible();
      for (const width of [320, 1366]) {
        await page.setViewportSize({ width, height: width === 320 ? 852 : 1024 });
        for (const theme of ["organizer", "classic-dark", "crt-green", "hitech-2000s"]) {
          await page.evaluate((theme) => {
            document.documentElement.dataset.theme = theme;
            document.documentElement.dataset.caseColor = "red";
          }, theme);
          for (const category of [
            "appearance",
            "sound",
            "connections",
            "library",
            "maintenance",
            "access",
          ]) {
            await choose(category);
            await expect(settings.locator(".settings-section:visible")).toHaveCount(1);
            const section = settings.locator(".settings-section:visible");
            assert(
              await section.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
              `${client} ${theme} ${width} ${category} content overflow`,
            );
            const rect = await settings.boundingBox();
            assert(rect.x >= 0 && rect.x + rect.width <= width + 1);
            const close = await button("Закрыть настройки").boundingBox();
            assert(
              close.width >= 44 &&
                close.height >= 44 &&
                close.x + close.width <= rect.x + rect.width,
            );
            if (category === "connections") {
              await expect(
                section.getByRole("button", { name: "Компьютеры", exact: true }),
              ).toBeVisible();
              await expect(
                section.getByRole("region", { name: "Подключение Codex", exact: true }),
              ).toBeVisible();
              await expect(
                section.getByRole("region", { name: "Подключение GPT", exact: true }),
              ).toBeVisible();
            }
            await page.screenshot({
              path: `.local/qa-settings/${engine}/${client}-${theme}-${width}-${category}.png`,
              animations: "disabled",
            });
          }
        }
      }
      await page.setViewportSize({ width: 393, height: 852 });
      await button("Все категории настроек").click();
      await expect(settings.locator('[data-category="access"]')).toBeFocused();
      await page.screenshot({ path: `.local/qa-settings/${engine}/${client}-index.png` });
      await page.keyboard.press("Escape");
      await expect(settings).not.toBeVisible();
      await expect(page.getByRole("textbox", { name: `Сообщение ${client}` })).toHaveValue(
        client === "GPT" ? "Черновик GPT" : "Не терять мой черновик",
      );
    }
    assert(
      f.desktopCalls.every((action) => action === "Status"),
      "Browsing categories can only read desktop status",
    );
    assert(
      !f.calls.some((c) => c.method === "turn/start"),
      "Browsing categories cannot send prompts",
    );
    assert.deepEqual(errors, []);
    console.log(
      `${engine}: categorized Codex/GPT settings, preserved forms/drafts, keyboard viewport and four-theme phone/tablet layout passed`,
    );
  } finally {
    await context.close();
    await browser.close();
    await f.close();
  }
}
