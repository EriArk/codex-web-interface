import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, expect, webkit } from "@playwright/test";
import { handoffFixture } from "./handoff-fixture.mjs";

// Resolve the actual CSS foreground against the nearest opaque reading surface,
// including every opaque gradient stop. Translucent grain/glints are decorative.
async function contrast(locator) {
  return locator.evaluate(async (el) => {
    // WebKit can defer inherited-color transitions until the next paint even
    // with reduced motion. Measure the rendered state after that paint.
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Contrast paint timed out")), 3000);
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          clearTimeout(timer);
          resolve();
        }),
      );
    });
    const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
    const rgba = (color) => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 1, 1);
      return [...ctx.getImageData(0, 0, 1, 1).data];
    };
    const luminance = (rgb) =>
      rgb
        .slice(0, 3)
        .map((v) => {
          const c = v / 255;
          return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        })
        .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
    const color = getComputedStyle(el).color;
    const foreground = luminance(rgba(color));
    for (let surface = el; surface; surface = surface.parentElement) {
      const style = getComputedStyle(surface);
      const stops = [...style.backgroundImage.matchAll(/rgba?\([^)]+\)|color\(srgb[^)]+\)/g)]
        .map((m) => rgba(m[0]))
        .filter((c) => c[3] === 255);
      const solid = rgba(style.backgroundColor);
      const backgrounds = stops.length ? stops : solid[3] === 255 ? [solid] : [];
      if (backgrounds.length)
        return {
          color,
          surface: surface.className,
          ratio: Math.min(
            ...backgrounds.map((c) => {
              const background = luminance(c);
              return (
                (Math.max(foreground, background) + 0.05) /
                (Math.min(foreground, background) + 0.05)
              );
            }),
          ),
        };
    }
    throw new Error("No opaque background for visible text");
  });
}

for (const [engine, type] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
  const origin = "http://127.0.0.1:18897";
  const f = await handoffFixture(origin);
  f.store.db.prepare("UPDATE threads SET origin='web' WHERE id=?").run(f.thread.id);
  f.store.setPreferences({
    projectId: "project",
    threadId: f.thread.id,
    theme: "hitech-2000s",
    view: "chat",
  });
  const browser = await type.launch();
  const context = await browser.newContext({
    viewport: { width: 393, height: 852 },
    hasTouch: true,
    serviceWorkers: "block",
    // Check settled colors; the separate tablet/polymer suites retain normal motion.
    reducedMotion: "reduce",
  });
  const [name, value] = f.headers.cookie.split("=");
  await context.addCookies([{ name, value, url: origin, httpOnly: true, sameSite: "Strict" }]);
  const page = await context.newPage();
  const failures = [],
    errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const button = (name) =>
    page.getByRole("button", { name, exact: true }).filter({ visible: true }).first();
  const colors = ["graphite", "turquoise", "green", "blue", "red", "orange", "silver"];
  const check = async (locator, label, minimum = 4.5) => {
    for (const color of colors) {
      await page.evaluate((c) => {
        document.documentElement.dataset.caseColor = c;
      }, color);
      const result = await contrast(locator);
      if (result.ratio < minimum) failures.push({ label, caseColor: color, ...result });
    }
    await page.evaluate(() => {
      document.documentElement.dataset.caseColor = "turquoise";
    });
  };
  const out = `.local/qa-hitech-contrast/${engine}`;
  await mkdir(out, { recursive: true });
  try {
    await f.app.listen({ port: 18897, host: "127.0.0.1" });
    await page.goto(origin);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "hitech-2000s");
    await page.evaluate(() => document.fonts.ready);
    const draft = page.getByRole("textbox", { name: "Сообщение Codex" });
    await draft.fill("Сохранить мой черновик");
    await draft.blur();
    for (const width of [393, 1366]) {
      await page.setViewportSize({ width, height: width === 393 ? 852 : 1024 });
      await page.evaluate(() => window.dispatchEvent(new Event("resize")));
      for (const el of await page
        .locator(".mobile-tabs > button, .support-tabs > button")
        .filter({ visible: true })
        .all()) {
        await check(el, `${width} workspace tab ${await el.innerText()}`);
      }
      if (width < 1100) await button("Открыть проекты").click();
      for (const count of await page
        .locator(".nav-mobile-switch small, .nav-mobile-switch .activity-badge b")
        .filter({ visible: true })
        .all()) {
        await check(count, `${width} navigation counts`);
      }
      const shortcut = page
        .locator(".workspace-shortcuts button")
        .filter({ visible: true })
        .first();
      await check(shortcut, `${width} shortcut idle`);
      await shortcut.hover();
      await check(shortcut, `${width} shortcut hover`);
      await shortcut.focus();
      await check(shortcut, `${width} shortcut focus`);
      const footer = page
        .locator(".navigation-system-row .icon-button")
        .filter({ visible: true })
        .first();
      const box = await footer.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await check(footer, `${width} footer pressed icon`, 3);
      await page.mouse.move(0, 0);
      await page.mouse.up();
      await page.screenshot({ path: `${out}/navigation-${width}.png`, animations: "disabled" });
      if (width < 1100) await button("Закрыть проекты").click();
      await button("Настройки").click();
      await check(
        page.locator(".settings-dialog .theme-option.hitech-2000s small"),
        `${width} settings description`,
      );
      await button("Закрыть настройки").click();
      await button("Обзор текущего проекта").click();
      await page
        .getByRole("region", { name: "Основа проекта", exact: true })
        .getByRole("button", { name: "Открыть", exact: true })
        .click();
      const core = page.getByRole("dialog", { name: "Основа проекта", exact: true });
      await expect(core.getByRole("textbox", { name: "Назначение", exact: true })).toBeEnabled();
      await check(
        core.getByRole("button", { name: "Сохранить", exact: true }),
        `${width} core Save`,
      );
      await check(core.locator(".core-heading-title small"), `${width} core subtitle`);
      await core
        .getByRole("textbox", { name: "Назначение", exact: true })
        .fill(`Проверка контраста ${width}`);
      await core.getByRole("button", { name: "Сохранить", exact: true }).click();
      await expect(core.getByRole("status")).toHaveText("Сохранено");
      await check(core.getByRole("status"), `${width} saved status`);
      if (width === 1366) {
        await core.getByRole("button", { name: "История основы проекта" }).click();
        await core.getByRole("button", { name: /^Версия 1 / }).click();
        await core.getByRole("button", { name: "Вернуть эту версию", exact: true }).click();
        await check(
          core.getByRole("button", { name: "Отмена", exact: true }),
          "restore Cancel on light cap",
        );
        await check(
          core.getByRole("button", { name: "Восстановить", exact: true }),
          "restore confirm on yellow cap",
        );
        await core.getByRole("button", { name: "Отмена", exact: true }).click();
      }
      await page.screenshot({ path: `${out}/core-${width}.png`, animations: "disabled" });
      await button("Закрыть основу проекта").click();
      await expect(draft).toHaveValue("Сохранить мой черновик");
    }
    // GPT shares the materials, but has its own navigation and Settings markup.
    await page.route("**/api/gpt/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      let data = { items: [], conversations: [], nextOffset: null };
      if (path.endsWith("/status"))
        data = {
          configured: true,
          connected: true,
          authenticated: true,
          locked: false,
          busy: false,
          canSend: true,
        };
      else if (path.endsWith("/models"))
        data = {
          models: [{ id: "Latest", label: "Latest" }],
          efforts: [{ id: "2", label: "High" }],
          currentModel: "Latest",
          currentEffort: "2",
        };
      else if (path.endsWith("/jobs")) data = { items: [], stamp: 1 };
      else if (path.endsWith("/conversations"))
        data = {
          items: [{ id: "contrast", title: "Проверка GPT", updatedAt: 1 }],
          nextOffset: null,
        };
      else if (path.endsWith("/messages"))
        data = {
          items: [
            {
              id: "answer",
              role: "assistant",
              text: "Текст на светлом экране.",
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
    await button("Переключиться на GPT").click();
    await button("Проверка GPT").click();
    await expect(page.locator(".gpt-chat .message-body")).toContainText("Текст на светлом экране.");
    const gptDraft = page.getByRole("textbox", { name: "Сообщение GPT" });
    await gptDraft.fill("Черновик GPT");
    await gptDraft.blur();
    for (const width of [393, 1366]) {
      await page.setViewportSize({ width, height: width === 393 ? 852 : 1024 });
      await page.evaluate(() => window.dispatchEvent(new Event("resize")));
      await check(page.locator(".gpt-chat .message-body p"), `${width} GPT response`);
      if (width < 1100) await button("Открыть проекты").click();
      await check(
        page.locator(".nav-thread.selected").filter({ visible: true }).first(),
        `${width} GPT selected chat`,
      );
      const shortcut = page
        .locator(".workspace-shortcuts button")
        .filter({ visible: true })
        .first();
      await check(shortcut, `${width} GPT shortcut idle`);
      await shortcut.hover();
      await check(shortcut, `${width} GPT shortcut hover`);
      await page.mouse.move(0, 0);
      await page.screenshot({ path: `${out}/gpt-navigation-${width}.png`, animations: "disabled" });
      if (width < 1100) await button("Закрыть проекты").click();
      await button("Настройки").click();
      await check(
        page.locator(".gpt-settings .theme-option.hitech-2000s small"),
        `${width} GPT Settings`,
      );
      await button("Закрыть настройки").click();
      await expect(gptDraft).toHaveValue("Черновик GPT");
    }
    assert.deepEqual(errors, []);
    assert.equal(
      f.calls.filter((c) => ["turn/start", "turn/steer", "turn/interrupt"].includes(c.method))
        .length,
      0,
    );
    assert.deepEqual(failures, [], "Hi-Tech controls must contrast with their own surface");
    console.log(
      `${engine}: Hi-Tech text and pressed/focused controls across seven casing colors, phone/tablet and preserved draft passed`,
    );
  } finally {
    await context.close();
    await browser.close();
    await f.close();
  }
}
