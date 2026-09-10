import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, expect, webkit } from "@playwright/test";
import { ProjectCores } from "../apps/hub/dist/project-core.js";
import { handoffFixture } from "./handoff-fixture.mjs";

await mkdir(".local/qa-core", { recursive: true });
for (const [engine, type] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
  const origin = "http://127.0.0.1:18859",
    f = await handoffFixture(origin),
    cores = new ProjectCores(f.sessions),
    scope = { client: "codex", projectId: "project", name: "Project" };
  f.store.setPreferences({
    projectId: "project",
    threadId: f.thread.id,
    theme: "classic-dark",
    view: "chat",
  });
  f.store.db.prepare("UPDATE threads SET origin='web' WHERE id=?").run(f.thread.id);
  const browser = await type.launch(),
    context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      serviceWorkers: "block",
    });
  try {
    await f.app.listen({ port: 18859, host: "127.0.0.1" });
    const [name, value] = f.headers.cookie.split("=");
    await context.addCookies([{ name, value, url: origin, httpOnly: true, sameSite: "Strict" }]);
    const page = await context.newPage(),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(origin);
    const chat = page.getByRole("textbox", { name: "Сообщение Codex" });
    await expect(chat).toBeVisible();
    await chat.fill("Не терять мой вопрос");
    const open = async () => {
      await page.getByRole("button", { name: "Обзор текущего проекта" }).click();
      await page
        .getByRole("region", { name: "Основа проекта", exact: true })
        .getByRole("button", { name: "Открыть", exact: true })
        .click();
    };
    await open();
    const panel = page.getByRole("dialog", { name: "Основа проекта", exact: true }),
      purpose = panel.getByRole("textbox", { name: "Назначение", exact: true });
    await expect(purpose).toBeEnabled();
    await purpose.fill("Домашняя библиотека");
    await panel
      .getByRole("textbox", { name: "Архитектура", exact: true })
      .fill("Windows → Hub → iPhone");
    await panel.getByRole("button", { name: "Закрыть основу проекта" }).click();
    // Closing the deeper modal returns directly to the mounted originating chat.
    await expect(page.getByRole("dialog", { name: "Обзор проекта" })).toHaveCount(0);
    await expect(chat).toHaveValue("Не терять мой вопрос");
    await open();
    await expect(purpose).toHaveValue("Домашняя библиотека");
    await panel.getByRole("button", { name: "Сохранить", exact: true }).click();
    await expect(panel.getByRole("status")).toHaveText("Сохранено");
    await purpose.fill("Мой вариант");
    const current = cores.get(scope);
    cores.save({ ...current, value: { ...current.value, purpose: "Вариант другого устройства" } });
    await panel.getByRole("button", { name: "Сохранить", exact: true }).click();
    await expect(panel.getByText("На другом устройстве сохранена версия 2.")).toBeVisible();
    await expect(purpose).toHaveValue("Мой вариант");
    await panel.getByRole("button", { name: "Сохранить мой вариант" }).click();
    await expect(panel.getByRole("status")).toHaveText("Сохранено");
    await panel.getByRole("button", { name: "История основы проекта" }).click();
    await panel.getByRole("button", { name: /^Версия 1 / }).click();
    await expect(panel.getByRole("textbox", { name: "Назначение", exact: true })).toHaveValue(
      "Домашняя библиотека",
    );
    await panel.getByRole("button", { name: "Вернуть эту версию", exact: true }).click();
    await panel.getByRole("button", { name: "Восстановить", exact: true }).click();
    await expect(panel.getByRole("status")).toHaveText("Сохранено");
    assert.equal(cores.get(scope).revision, 4);
    for (const theme of ["classic-dark", "crt-green", "organizer", "hitech-2000s"]) {
      await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
      for (const width of [390, 1366]) {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 1024 });
        await page.screenshot({ path: `.local/qa-core/${engine}-${theme}-${width}.png` });
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      }
    }
    assert.equal(
      f.calls.filter((c) => ["turn/start", "thread/resume"].includes(c.method)).length,
      0,
    );
    assert.deepEqual(errors, []);
    console.log(
      engine +
        ": core edits, local draft, conflict, history restore, themes and chat preservation passed",
    );
  } finally {
    await context.close();
    await browser.close();
    await f.close();
  }
}
