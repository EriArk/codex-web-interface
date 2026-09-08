import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, expect, webkit } from "@playwright/test";
import { handoffFixture } from "./handoff-fixture.mjs";

await mkdir(".local/qa-project-results", { recursive: true });
for (const [engine, type] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
  const origin = "http://127.0.0.1:18851",
    f = await handoffFixture(origin);
  const browser = await type.launch();
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    serviceWorkers: "block",
  });
  try {
    f.store.db.prepare("UPDATE threads SET origin='web' WHERE id=?").run(f.thread.id);
    f.store.setPreferences({ projectId: "project", threadId: f.thread.id, theme: "crt-green" });
    f.store.append(
      f.thread.id,
      "assistant.completed",
      { id: "original-answer", text: "Первоначальный диалог" },
      "first",
    );
    f.store.append(
      f.thread.id,
      "assistant.completed",
      {
        id: "live-update",
        text: "Сохраняю результат и проверяю файлы проекта.",
        phase: "commentary",
      },
      "first",
    );
    const other = f.store.createThread("project", "export-native", "Экспортный чат");
    f.store.append(
      other.id,
      "user.message",
      { id: "other-user", text: "Собери отчёт" },
      "export-turn",
    );
    f.store.append(
      other.id,
      "assistant.completed",
      { id: "other-answer", text: "Отчёт из другого диалога" },
      "export-turn",
    );
    f.sessions.catalog.artifacts.read = async () =>
      Buffer.from("# Сохранённый отчёт\n\nТочные данные\n");
    f.sessions.catalog.artifacts.observe(other, "export-turn", {
      id: "other-answer",
      type: "agentMessage",
      text: "[Отчёт](report.md)",
    });
    await f.sessions.catalog.artifacts.close();
    for (let n = 0; n < 22; n++)
      f.store.result(other.id, "work" + n, "check" + n, "check", "Проверка " + n, { exitCode: 0 });
    await f.app.listen({ port: 18851, host: "127.0.0.1" });
    const [name, value] = f.headers.cookie.split("=");
    await context.addCookies([{ name, value, url: origin, httpOnly: true, sameSite: "Strict" }]);
    const page = await context.newPage();
    await page.goto(origin);
    const editor = page.getByRole("textbox", { name: "Сообщение Codex" });
    await expect(editor).toBeVisible();
    await editor.fill("Мой черновик");
    await expect(page.locator(".commentary-message")).toContainText("Сохраняю результат");
    await page.screenshot({
      path: `.local/qa-project-results/${engine}-brighter-live.png`,
      animations: "disabled",
    });
    await page
      .getByRole("button", { name: "Результаты", exact: true })
      .filter({ visible: true })
      .last()
      .tap();
    const pane = page.getByRole("region", { name: "Результаты", exact: true });
    for (let pass = 0; pass < 3; pass++) {
      await pane.getByRole("button", { name: "Весь проект", exact: true }).tap();
      await expect(page.locator(".result-scope")).toHaveCount(1);
      await pane.getByRole("button", { name: "Диалог", exact: true }).tap();
      await expect(page.locator(".result-scope")).toHaveCount(1);
    }
    await pane.getByRole("button", { name: "Весь проект", exact: true }).tap();
    await expect(pane.getByRole("heading", { name: "Проверка 21", exact: true })).toBeVisible();
    await pane.getByRole("button", { name: /^Файлы/ }).tap();
    await expect(pane.getByRole("heading", { name: "report.md", exact: true })).toBeVisible();
    await page.screenshot({ path: `.local/qa-project-results/${engine}-phone.png` });
    await pane.getByRole("button", { name: "Открыть файл", exact: true }).tap();
    await expect(pane.locator("pre")).toContainText("Сохранённый отчёт");
    await pane.getByRole("button", { name: "Вернуться к результатам", exact: true }).tap();
    await pane.getByRole("button", { name: /Экспортный чат/ }).tap();
    await expect(page.getByText("Отчёт из другого диалога", { exact: true })).toBeVisible();
    await expect(editor).toHaveValue("");
    f.store.setPreferences({ projectId: "project", threadId: f.thread.id, theme: "crt-green" });
    await page.reload();
    await expect(editor).toHaveValue("Мой черновик");
    await page.setViewportSize({ width: 1366, height: 1024 });
    await pane.getByRole("button", { name: "Весь проект", exact: true }).click();
    await pane.getByRole("button", { name: /^Файлы/ }).click();
    for (const theme of ["crt-green", "organizer", "hitech-2000s", "classic-dark"]) {
      await page
        .getByRole("button", { name: "Настройки", exact: true })
        .filter({ visible: true })
        .first()
        .click();
      await page.locator(`.theme-option.${theme} input`).check();
      await page.getByRole("button", { name: "Закрыть настройки", exact: true }).click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await page.screenshot({ path: `.local/qa-project-results/${engine}-tablet-${theme}.png` });
    }
    assert.equal(
      f.calls.filter((c) => ["thread/resume", "turn/start"].includes(c.method)).length,
      0,
    );
    assert.equal(f.desktopCalls.filter((action) => action !== "Status").length, 0);
    console.log(
      engine +
        ": project library, category-before-pagination, file preview, cross-chat origin and preserved draft; no writer acquisition",
    );
  } finally {
    await context.close();
    await browser.close();
    await f.close();
  }
}
