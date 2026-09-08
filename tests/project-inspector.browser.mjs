import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect, webkit } from "@playwright/test";
import { handoffFixture } from "./handoff-fixture.mjs";

await mkdir(".local/qa-project-inspector", { recursive: true });
for (const [engine, type] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
  const origin = "http://127.0.0.1:18853",
    f = await handoffFixture(origin),
    root = await mkdtemp(join(tmpdir(), "inspector-browser-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "-b", "main");
  await writeFile(join(root, "readme.md"), "# Файл проекта\n\nИсходный текст\n");
  git("add", ".");
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "Начало проекта",
  );
  await writeFile(join(root, "readme.md"), "# Файл проекта\n\nНовый текст\n");
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src/пример.ts"), "export const value = 42;\n");
  f.sessions.config.machines[0].type = "local-linux";
  f.sessions.config.projects[0].workingDirectory = root;
  f.store.db.prepare("UPDATE threads SET origin='web' WHERE id=?").run(f.thread.id);
  f.store.setPreferences({
    projectId: "project",
    threadId: f.thread.id,
    theme: "crt-green",
    view: "chat",
  });
  f.store.result(f.thread.id, "change", "turn", "fileChange", "Изменён readme", {
    changes: [{ path: join(root, "readme.md"), kind: "update", diff: "Сохранённый diff" }],
  });
  const browser = await type.launch(),
    context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      serviceWorkers: "block",
    });
  try {
    await f.app.listen({ port: 18853, host: "127.0.0.1" });
    const [name, value] = f.headers.cookie.split("=");
    await context.addCookies([{ name, value, url: origin, httpOnly: true, sameSite: "Strict" }]);
    const page = await context.newPage();
    await page.goto(origin);
    const editor = page.getByRole("textbox", { name: "Сообщение Codex" });
    await expect(editor).toBeVisible();
    await editor.fill("Не терять черновик");
    await page
      .getByRole("button", { name: "Настройки", exact: true })
      .filter({ visible: true })
      .first()
      .tap();
    await page.getByRole("button", { name: "Файлы и Git проекта", exact: true }).tap();
    const pane = page.getByRole("region", { name: "Файлы и Git", exact: true });
    await expect(pane).toBeVisible();
    await pane.getByRole("button", { name: /^readme.md/ }).tap();
    await pane.getByRole("button", { name: "Открыть файл", exact: true }).tap();
    const dialog = page.getByRole("dialog");
    await expect(dialog.locator("pre")).toContainText("Новый текст");
    await dialog.getByRole("button", { name: /Закрыть/ }).tap();
    await expect(pane).toBeVisible();
    await pane.getByRole("button", { name: "Git", exact: true }).tap();
    await expect(pane.getByText("main", { exact: true })).toBeVisible();
    await pane.getByRole("button", { name: /M readme.md/ }).tap();
    await expect(pane.locator(".inspector-diff")).toContainText("+Новый текст");
    await page.screenshot({ path: `.local/qa-project-inspector/${engine}-phone-diff.png` });
    await pane.getByRole("button", { name: "Вернуться к чату" }).tap();
    await expect(editor).toHaveValue("Не терять черновик");
    await page
      .getByRole("button", { name: /^Результаты/ })
      .filter({ visible: true })
      .last()
      .tap();
    const result = page.getByRole("region", { name: /^Результаты/ });
    await result.locator(".file-change summary").tap();
    await result.getByRole("button", { name: "Посмотреть файл", exact: true }).tap();
    await expect(pane.getByRole("region", { name: "Выбранный файл" })).toContainText("readme.md");
    await expect(
      pane.locator(".inspector-list").getByRole("button", { name: /^readme.md/ }),
    ).toBeVisible();
    await expect(pane.getByRole("alert")).toHaveCount(0);
    await page.setViewportSize({ width: 844, height: 390 });
    await page.screenshot({ path: `.local/qa-project-inspector/${engine}-landscape.png` });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.setViewportSize({ width: 1366, height: 1024 });
    await pane.getByRole("button", { name: "Git", exact: true }).click();
    await expect(pane.getByText("main", { exact: true })).toBeVisible();
    await pane.locator(".inspector-commits summary").click();
    for (const theme of ["crt-green", "organizer", "hitech-2000s", "classic-dark"]) {
      await page
        .getByRole("button", { name: "Настройки", exact: true })
        .filter({ visible: true })
        .first()
        .click();
      await page.locator(`.theme-option.${theme} input`).check();
      await page.getByRole("button", { name: "Закрыть настройки", exact: true }).click();
      await page.screenshot({ path: `.local/qa-project-inspector/${engine}-tablet-${theme}.png` });
    }
    assert.equal(
      f.calls.filter((c) => ["thread/resume", "turn/start"].includes(c.method)).length,
      0,
    );
    assert.equal(f.desktopCalls.filter((a) => a !== "Status").length, 0);
    console.log(
      engine +
        ": private file preview, Git diff, result jump, phone/landscape/tablet, themes and unchanged draft; no writer acquired",
    );
  } finally {
    await context.close();
    await browser.close();
    await f.close();
    await rm(root, { recursive: true, force: true });
  }
}
