import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, expect, webkit } from "@playwright/test";
import { preparationFixture } from "./project-preparation-fixture.mjs";

const engine = process.env.BROWSER ?? "webkit",
  origin = "http://127.0.0.1:18963",
  f = await preparationFixture(origin),
  p = await f.create();
f.store.setPreferences({
  projectId: "project",
  threadId: f.thread.id,
  theme: "classic-dark",
  view: "chat",
});
const browser = await (engine === "webkit" ? webkit : chromium).launch(),
  context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    serviceWorkers: "block",
  });
await mkdir(".local/qa-preparation", { recursive: true });
try {
  await f.app.listen({ port: 18963, host: "127.0.0.1" });
  const [name, value] = f.headers.cookie.split("=");
  await context.addCookies([{ name, value, url: origin, httpOnly: true, sameSite: "Strict" }]);
  const page = await context.newPage(),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(origin);
  const composer = page.getByRole("textbox", { name: "Сообщение Codex" });
  await expect(composer).toBeVisible();
  await composer.fill("Сохранить исходный черновик");
  await page.getByRole("button", { name: "Обзор текущего проекта", exact: true }).click();
  await page
    .locator(".project-overview-modal")
    .getByRole("button", { name: /GPT проекта Личный чат/ })
    .click();
  const project = page.locator(".project-gpt-window");
  await project.getByRole("button", { name: "Подготовить для Codex", exact: true }).click();
  const window = page.locator(".preparation-window"),
    text = window.getByRole("textbox", { name: "Содержимое файла 1", exact: true });
  await expect(text).toHaveValue(/Обновлённый/);
  await text.fill("# Проверено\n\nТочный текст, сохранённый после повторного открытия.");
  await project.getByRole("button", { name: "Закрыть подготовку", exact: true }).click();
  await project.getByRole("button", { name: "Подготовить для Codex", exact: true }).click();
  await expect(text).toHaveValue(/Точный текст/);
  await window.getByLabel("Действие с файлом 1", { exact: true }).selectOption("replace");
  await window.getByRole("button", { name: "Добавить Issue", exact: true }).click();
  const extra = window.locator(".preparation-file").last();
  await extra.locator("summary").click();
  await extra.getByLabel("Название Issue", { exact: true }).fill("Дополнительная проверка");
  await extra.getByLabel("Описание Issue", { exact: true }).fill("Критерии, выбранные вручную.");
  await extra.getByRole("button", { name: "Не публиковать этот Issue", exact: true }).click();
  await window.locator('input[type="file"]').setInputFiles({
    name: "reference.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Exact material bytes\r\n"),
  });
  await expect(
    window.locator("summary").filter({ hasText: "references/reference.txt" }),
  ).toBeVisible();

  await page.evaluate(() => {
    document.querySelector(".preparation-window .notebook-heading small").textContent =
      "Очень длинное название проекта с обсуждением интерфейса и материалов";
  });
  for (const size of [
    { width: 390, height: 844 },
    { width: 390, height: 500 },
    { width: 768, height: 1024 },
    { width: 1024, height: 768 },
    { width: 1366, height: 1024 },
  ]) {
    await page.setViewportSize(size);
    await expect
      .poll(() =>
        page.evaluate(() =>
          parseFloat(document.documentElement.style.getPropertyValue("--app-height")),
        ),
      )
      .toBe(size.height);
    for (const theme of ["organizer", "crt-green", "hitech-2000s", "classic-dark"]) {
      await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
      const b = await window.evaluate((el) => {
        const r = el.getBoundingClientRect(),
          close = el.querySelector('[aria-label="Закрыть подготовку"]').getBoundingClientRect(),
          foot = el.querySelector("footer").getBoundingClientRect();
        return {
          left: r.left,
          right: r.right,
          top: r.top,
          bottom: r.bottom,
          overflow: el.scrollWidth > el.clientWidth + 1,
          close: { width: close.width, height: close.height },
          foot: foot.bottom,
        };
      });
      assert(
        b.left >= -1 &&
          b.right <= size.width + 1 &&
          b.top >= -1 &&
          b.bottom <= size.height + 1 &&
          !b.overflow,
        JSON.stringify({ size, theme, b }),
      );
      assert(b.close.width >= 44 && b.close.height >= 44);
      assert(b.foot <= size.height + 1);
      await page.screenshot({
        path: `.local/qa-preparation/${engine}-${theme}-${size.width}x${size.height}.png`,
      });
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await window.getByRole("button", { name: "Проверить пакет", exact: true }).click();
  await expect(
    window.getByRole("button", { name: "Подтвердить публикацию", exact: true }),
  ).toBeEnabled();
  assert.equal(f.operations.filter((q) => q.op === "apply").length, 0);
  await window.getByRole("button", { name: "Подтвердить публикацию", exact: true }).click();
  await expect(
    window.getByRole("button", { name: "Открыть план в Codex", exact: true }),
  ).toBeVisible({ timeout: 20000 });
  await window.getByRole("button", { name: "Открыть план в Codex", exact: true }).click();
  await expect(window).toHaveCount(0);
  assert.equal(f.service.handoff("project", p.id, f.projectWork).kind, "plan");
  assert.equal(f.calls.filter((c) => c.method === "turn/start").length, 0);
  assert.deepEqual(errors, []);
  console.log(
    `${engine}: preparation edit/reopen, exact confirmation, publication, plan handoff and four-theme layouts passed`,
  );
} finally {
  await browser.close();
  await f.close();
}
