import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, expect, webkit } from "@playwright/test";
import react from "../apps/web/node_modules/@vitejs/plugin-react/dist/index.js";
import { build } from "../apps/web/node_modules/vite/dist/node/index.js";
import { handoffFixture } from "./handoff-fixture.mjs";

const dir = await mkdtemp(join(tmpdir(), "workspace-help-"));
await mkdir(".local/qa-help", { recursive: true });
try {
  await build({
    configFile: false,
    root: resolve("apps/web"),
    plugins: [react()],
    logLevel: "error",
    build: {
      target: "esnext",
      outDir: dir,
      emptyOutDir: true,
      rolldownOptions: { input: resolve("apps/web/tests/fixtures/workspace-help.html") },
    },
  });
  const origin = "http://127.0.0.1:18873",
    fixture = await handoffFixture(origin, dir);
  await fixture.app.listen({ host: "127.0.0.1", port: 18873 });
  try {
    for (const [engine, type] of [
      ["chromium", chromium],
      ["webkit", webkit],
    ].filter(([name]) => !process.env.BROWSER || process.env.BROWSER === name)) {
      const browser = await type.launch();
      try {
        const context = await browser.newContext({
          viewport: { width: 390, height: 844 },
          hasTouch: true,
        });
        const [name, value] = fixture.headers.cookie.split("=");
        await context.addCookies([{ name, value, url: origin }]);
        const page = await context.newPage(),
          errors = [];
        page.on("pageerror", (e) => errors.push(e.message));
        await page.goto(origin + "/tests/fixtures/workspace-help.html");
        const input = page.getByRole("textbox", { name: "Сообщение" });
        await input.press("Control+Enter");
        await expect(page.getByLabel("Отправлено")).toHaveText("1");
        await input.press("Meta+Enter");
        await expect(page.getByLabel("Отправлено")).toHaveText("2");
        for (const extras of [{ isComposing: true }, { repeat: true }, { altKey: true }])
          await input.evaluate(
            (el, extras) =>
              el.dispatchEvent(
                new KeyboardEvent("keydown", {
                  key: "Enter",
                  ctrlKey: true,
                  bubbles: true,
                  cancelable: true,
                  ...extras,
                }),
              ),
            extras,
          );
        await expect(page.getByLabel("Отправлено")).toHaveText("2");
        await page.getByRole("button", { name: "Блокировка" }).tap();
        await input.press("Control+Enter");
        await expect(page.getByLabel("Отправлено")).toHaveText("2");
        await input.press("Enter");
        await expect(input).toHaveValue("\nЧерновик");
        await input.press("F1");
        await expect(page.getByRole("heading", { name: "Чат GPT" })).toBeVisible();
        await page.keyboard.press("F1");
        await expect(page.getByRole("dialog")).toHaveCount(1);
        await page.keyboard.press("Escape");
        await expect(input).toBeFocused();
        await page.getByLabel("Терминал").focus();
        const stolen = await page
          .getByLabel("Терминал")
          .evaluate(
            (el) =>
              !el.dispatchEvent(
                new KeyboardEvent("keydown", { key: "F1", bubbles: true, cancelable: true }),
              ),
          );
        assert.equal(stolen, false);
        await expect(page.getByRole("dialog")).toHaveCount(0);
        await page.getByRole("button", { name: "Настройки", exact: true }).tap();
        await page
          .getByRole("dialog", { name: "Настройки приложения" })
          .getByRole("button", { name: "Справка и клавиши" })
          .tap();
        await expect(page.getByRole("navigation", { name: "Категории справки" })).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(page.getByRole("dialog", { name: "Настройки приложения" })).toBeVisible();
        await page.getByRole("button", { name: "Закрыть настройки" }).tap();
        await page.getByRole("button", { name: "Справка и клавиши" }).tap();
        const guide = page.getByRole("dialog", { name: "Справка и клавиши" }),
          catalog = guide.getByRole("navigation", { name: "Категории справки" });
        await expect(catalog.locator("summary")).toHaveCount(11);
        await catalog.getByText("Материалы и файлы", { exact: true }).click();
        await expect(catalog.getByRole("heading", { name: "Редактор", exact: true })).toBeVisible();
        await catalog
          .getByRole("button", { name: "Слияние папок и совпадения", exact: true })
          .tap();
        await expect(
          guide.getByRole("heading", { name: "Слияние папок и совпадения", exact: true }),
        ).toBeVisible();
        await guide
          .getByRole("navigation", { name: "В этой статье" })
          .getByRole("button", { name: "Пример", exact: true })
          .tap();
        await expect(guide.getByRole("heading", { name: "Пример", exact: true })).toBeInViewport();
        const priorScroll = await guide.locator(".help-content").evaluate((el) => el.scrollTop);
        assert(priorScroll > 0);
        await guide
          .getByRole("navigation", { name: "Связанные статьи" })
          .getByRole("button", {
            name: "Копировать, вырезать, переименовать, удалить",
            exact: true,
          })
          .tap();
        await guide.getByRole("button", { name: "Назад", exact: true }).tap();
        await expect
          .poll(() => guide.locator(".help-content").evaluate((el) => el.scrollTop))
          .toBe(priorScroll);
        await guide.getByRole("searchbox", { name: "Поиск по справке" }).fill("УЧЕТН");
        await expect(
          catalog.getByRole("button", { name: /Полный доступ и GitHub Write/ }),
        ).toBeVisible();
        await catalog.getByRole("button", { name: /Полный доступ и GitHub Write/ }).tap();
        await expect(guide.locator(".help-content")).toContainText("а не Admin");
        await guide
          .getByRole("searchbox", { name: "Поиск по справке" })
          .fill("несуществующий_раздел_123");
        await expect(catalog).toContainText("Ничего не найдено");
        await catalog.getByRole("button", { name: "Сбросить поиск" }).tap();
        await catalog.getByText("Рабочие циклы", { exact: true }).tap();
        await catalog.getByRole("button", { name: "От брейншторма до проекта", exact: true }).tap();
        await expect(guide.locator(".help-content ol li")).toHaveCount(7);
        await page.keyboard.press("Escape");
        for (const theme of ["organizer", "crt-green", "hitech-2000s", "classic-dark"])
          for (const [layout, viewport] of [
            ["phone", { width: 390, height: 844 }],
            ["keyboard", { width: 390, height: 430 }],
            ["tablet", { width: 768, height: 1024 }],
            ["wide", { width: 1366, height: 1024 }],
          ]) {
            await page.setViewportSize(viewport);
            await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
            await page.getByRole("button", { name: "Файл", exact: true }).tap();
            await page
              .getByRole("dialog", { name: "Просмотр файла" })
              .getByRole("button", { name: "Справка и клавиши" })
              .tap();
            await expect(page.getByRole("heading", { name: "Файлы и просмотр" })).toBeVisible();
            await page.getByRole("button", { name: "Клавиши", exact: true }).tap();
            await expect(page.locator(".help-content")).toContainText("Ctrl / ⌘ + Enter");
            await guide.getByRole("button", { name: "Оглавление справки" }).tap();
            await expect(guide.getByRole("searchbox")).not.toBeFocused();
            await page.screenshot({
              path: `.local/qa-help/${engine}-${theme}-${layout}-index.png`,
            });
            await guide
              .getByRole("searchbox", { name: "Поиск по справке" })
              .fill("От задачи до готового изменения");
            await catalog.getByRole("button", { name: /От задачи до готового изменения/ }).tap();
            await expect(guide.locator(".help-content ol li")).toHaveCount(7);
            const bounds = await page
              .getByRole("dialog", { name: "Справка и клавиши" })
              .boundingBox();
            assert(
              bounds.x >= 0 &&
                bounds.y >= 0 &&
                bounds.x + bounds.width <= viewport.width + 1 &&
                bounds.y + bounds.height <= viewport.height + 1,
            );
            await expect(page.getByRole("button", { name: "Закрыть справку" })).toBeInViewport();
            await page.screenshot({ path: `.local/qa-help/${engine}-${theme}-${layout}.png` });
            await page.keyboard.press("Escape");
            await expect(page.getByRole("dialog", { name: "Просмотр файла" })).toBeVisible();
            await expect(
              page.getByRole("dialog").getByRole("button", { name: "Справка и клавиши" }),
            ).toBeFocused();
            await page.keyboard.press("F1");
            await expect(page.getByRole("heading", { name: "Файлы и просмотр" })).toBeVisible();
            await page.keyboard.press("Escape");
            await page.getByRole("button", { name: "Закрыть просмотр" }).tap();
          }
        await expect(input).toHaveValue("\nЧерновик");
        assert.deepEqual(errors, []);
        console.log(engine + " workspace help browser passed");
      } finally {
        await browser.close();
      }
    }
  } finally {
    await fixture.close();
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}
