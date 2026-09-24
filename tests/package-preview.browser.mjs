import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, expect, webkit } from "@playwright/test";
import react from "../apps/web/node_modules/@vitejs/plugin-react/dist/index.js";
import { build } from "../apps/web/node_modules/vite/dist/node/index.js";
import { handoffFixture } from "./handoff-fixture.mjs";
import { archive, sheet, word } from "./package-fixtures.mjs";

const dir = await mkdtemp(join(tmpdir(), "package-browser-"));
await mkdir(".local/qa-package", { recursive: true });
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
      rolldownOptions: { input: resolve("apps/web/tests/fixtures/file-popup.html") },
    },
  });
  const origin = "http://127.0.0.1:18869",
    fixture = await handoffFixture(origin, dir);
  await fixture.app.listen({ host: "127.0.0.1", port: 18869 });
  try {
    const files = {};
    for (const [name, bytes] of [
      ["План проекта — подробное описание работ.docx", word],
      ["Смета.xlsx", sheet],
      ["Материалы.zip", archive],
      ["Поврежден.zip", Buffer.from("PKbroken")],
    ]) {
      const item = await fixture.sessions.attachments.put(fixture.thread.id, name, bytes);
      files[
        name.split(".").at(-1) === "zip"
          ? name.startsWith("Пов")
            ? "broken"
            : "zip"
          : name.split(".").at(-1)
      ] = { name, url: "/api/attachments/" + item.id };
      assert.equal(
        (await fixture.app.inject({ url: "/api/attachments/" + item.id })).statusCode,
        401,
      );
    }
    for (const [engine, type] of [
      ["chromium", chromium],
      ["webkit", webkit],
    ].filter(([name]) => !process.env.BROWSER || process.env.BROWSER === name)) {
      const browser = await type.launch();
      try {
        const context = await browser.newContext({
          viewport: { width: 390, height: 844 },
          hasTouch: true,
          serviceWorkers: "block",
        });
        const [name, value] = fixture.headers.cookie.split("=");
        await context.addCookies([{ name, value, url: origin }]);
        const page = await context.newPage(),
          errors = [],
          outside = [];
        page.on("pageerror", (e) => errors.push(e.message));
        page.on("request", (r) => {
          if (/^https?:/.test(r.url()) && !r.url().startsWith(origin)) outside.push(r.url());
        });
        const open = async (key) => {
          await page.goto(
            origin +
              "/tests/fixtures/file-popup.html?" +
              new URLSearchParams({ file: files[key].url, name: files[key].name }),
          );
          await page.getByRole("textbox", { name: "Draft" }).fill("Preserved exact draft");
          await page.getByRole("button", { name: "Открыть файл" }).tap();
          await expect(page.getByRole("dialog")).toBeVisible();
        };
        await open("zip");
        await page.getByRole("button", { name: /Документы Папка/ }).tap();
        await page.getByRole("button", { name: /план.md/ }).tap();
        await expect(page.getByRole("dialog")).toHaveCount(2);
        await expect(page.locator(".readable-file")).toContainText("Текст из архива");
        await expect(page.getByRole("button", { name: /Редактировать/ })).toBeVisible();
        const download = page.waitForEvent("download");
        await page.getByRole("link", { name: "Скачать", exact: true }).tap();
        const downloaded = await download;
        assert.equal(downloaded.suggestedFilename(), "план.md");
        assert.equal(
          await readFile(await downloaded.path(), "utf8"),
          "# План\n\nТекст из архива\n",
        );
        await page.getByRole("button", { name: "Закрыть просмотр" }).last().tap();
        await expect(page.locator(".package-path")).toHaveText("Документы/");
        await page.getByRole("button", { name: /смета.xlsx/ }).tap();
        await expect(page.locator(".office-sheet")).toContainText("Материалы");
        await page.getByRole("button", { name: "Закрыть просмотр" }).last().tap();
        await page.getByRole("button", { name: "На уровень выше" }).tap();
        await expect(page.getByRole("button", { name: /небезопасно/ })).toBeDisabled();
        await page.getByRole("button", { name: "Закрыть просмотр" }).tap();
        await expect(page.getByRole("textbox", { name: "Draft" })).toHaveValue(
          "Preserved exact draft",
        );
        await open("xlsx");
        await expect(page.locator(".office-sheet")).toContainText("Материалы");
        await page.getByLabel("Формула C1").tap();
        await expect(page.locator(".office-formula code")).toHaveText("=SUM(C2:C3)");
        await page.getByRole("button", { name: "Следующая страница" }).tap();
        await expect(page.locator(".office-sheet")).toContainText("Позиция 105");
        await page.getByLabel("Лист", { exact: true }).selectOption("1");
        await expect(page.locator(".office-sheet")).toContainText("Второй лист");
        await page.getByLabel("Поиск в документе").fill("absent");
        await expect(page.getByText("Нет содержимого по этому выбору.")).toBeVisible();
        await open("broken");
        await expect(
          page.getByText("Архив повреждён или его формат не поддерживается."),
        ).toBeVisible();
        await expect(page.getByRole("link", { name: "Скачать файл" })).toBeVisible();
        for (const theme of ["organizer", "crt-green", "hitech-2000s", "classic-dark"])
          for (const [layout, viewport] of [
            ["phone", { width: 390, height: 844 }],
            ["keyboard", { width: 390, height: 430 }],
            ["tablet", { width: 768, height: 1024 }],
            ["wide", { width: 1366, height: 1024 }],
          ]) {
            await page.setViewportSize(viewport);
            await open(layout === "tablet" ? "xlsx" : "docx");
            await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
            await expect(
              page.locator(layout === "tablet" ? ".office-sheet" : ".office-document"),
            ).toContainText(layout === "tablet" ? "Материалы" : "План проекта");
            if (layout !== "tablet") {
              await expect
                .poll(() => page.locator(".office-image").evaluate((img) => img.naturalWidth))
                .toBe(1);
              await page.getByLabel("Размер текста").selectOption("125");
            }
            const bounds = await page.getByRole("dialog").boundingBox();
            assert(
              bounds.x >= 0 &&
                bounds.y >= 0 &&
                bounds.x + bounds.width <= viewport.width + 1 &&
                bounds.y + bounds.height <= viewport.height + 1,
            );
            await expect(page.getByRole("button", { name: "Закрыть просмотр" })).toBeInViewport();
            await page.screenshot({ path: `.local/qa-package/${engine}-${theme}-${layout}.png` });
          }
        await page.route("**/*packagePreview.worker*", (route) =>
          route.fulfill({
            contentType: "application/javascript",
            body: "self.onmessage = () => {};",
          }),
        );
        await open("zip");
        await expect(
          page.getByText("Просмотр занял слишком много времени. Оригинал можно скачать."),
        ).toBeVisible({ timeout: 20000 });
        await page.getByRole("button", { name: "Закрыть просмотр" }).tap();
        await page.unroute("**/*packagePreview.worker*");
        await open("zip");
        await page.getByRole("button", { name: /Документы Папка/ }).tap();
        await page.getByRole("button", { name: "Закрыть просмотр" }).tap();
        await expect(page.getByRole("textbox", { name: "Draft" })).toHaveValue(
          "Preserved exact draft",
        );
        assert.deepEqual(errors, []);
        assert.deepEqual(outside, []);
        console.log(engine + " package viewer browser passed");
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
