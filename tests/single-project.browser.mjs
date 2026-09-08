import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, expect, webkit } from "@playwright/test";
import { handoffFixture } from "./handoff-fixture.mjs";

await mkdir(".local/qa-single-project", { recursive: true });
for (const [engine, type] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
  const origin = "http://127.0.0.1:18859",
    f = await handoffFixture(origin);
  f.store.db.prepare("UPDATE threads SET origin='web' WHERE id=?").run(f.thread.id);
  f.store.setPreferences({
    projectId: "project",
    threadId: f.thread.id,
    view: "chat",
    theme: "crt-green",
  });
  for (const id of ["other", "unknown", "fresh"])
    f.sessions.config.projects.push({
      id,
      name: id,
      machineId: "pc",
      workingDirectory: "C:/" + id,
      enabled: true,
    });
  const other = f.store.createThread("other", "native-other", "Другой чат");
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
    const editor = page.getByRole("textbox", { name: "Сообщение Codex" });
    await expect(editor).toBeVisible();
    await editor.fill("Первый сохранённый черновик");
    const open = () => page.getByRole("button", { name: "Открыть проекты", exact: true }).click();
    const row = (id) =>
      page.locator(`.nav-project[data-project-id="${id}"]`).filter({ visible: true });
    const group = (id) =>
      page
        .locator(".nav-project-group")
        .filter({ has: page.locator(`[data-project-id="${id}"]`) })
        .filter({ visible: true });
    await open();
    assert.equal(await row("project").getAttribute("aria-expanded"), null);
    assert.equal(
      await group("project").locator(".project-chevron, .project-thread-list").count(),
      0,
    );
    await row("other").click();
    await expect(page.locator(".project-sheet")).not.toBeVisible();
    await expect(editor).toHaveValue("");
    await expect.poll(() => f.store.preferences().threadId).toBe(other.id);
    await editor.fill("Второй черновик");
    await expect
      .poll(() => page.evaluate((id) => sessionStorage.getItem("codex-draft-" + id), other.id))
      .toBe("Второй черновик");
    await open();
    await row("project").click();
    await expect(editor).toHaveValue("Первый сохранённый черновик");
    // New chat is the first project action, leaving source files and existing draft alone.
    let creates = 0,
      added;
    await page.route("**/api/projects/project/threads", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      creates++;
      added = f.store.createThread("project", "native-second", "Новый диалог");
      await route.fulfill({ json: added });
    });
    await open();
    await group("project").getByRole("button", { name: "Действия: Project", exact: true }).click();
    const menu = page.locator(".entity-dialog[open]");
    assert.deepEqual(await menu.locator(".entity-actions > button").allTextContents(), [
      "Новый чат",
      "Закрепить",
      "Переименовать",
      "Архивировать",
      "Удалить",
    ]);
    await menu.getByRole("button", { name: "Новый чат", exact: true }).click();
    await expect(menu).toHaveCount(0);
    await expect(editor).toHaveValue("");
    assert.equal(creates, 1);
    await open();
    await expect(row("project")).toHaveAttribute("aria-expanded", "true");
    await expect(group("project").locator(".project-thread-list .nav-thread")).toHaveCount(2);
    await row("project").click();
    await expect(row("project")).toHaveAttribute("aria-expanded", "false");
    await row("project").click();
    await group("project").locator(`[data-thread-id="${f.thread.id}"]`).click();
    await expect(editor).toHaveValue("Первый сохранённый черновик");
    // A delayed discovery cannot steal navigation after a different direct project tap.
    let release,
      began = false;
    await page.route("**/api/projects/unknown/threads", async (route) => {
      began = true;
      await new Promise((resolve) => {
        release = resolve;
      });
      const discovered = f.store.createThread("unknown", "native-unknown", "Поздний чат");
      await route.fulfill({ json: { threads: [discovered] } });
    });
    await open();
    await row("unknown").click();
    await expect.poll(() => began).toBe(true);
    await row("other").click();
    await expect(editor).toHaveValue("Второй черновик");
    release();
    await expect.poll(() => f.store.preferences().threadId).toBe(other.id);
    // First-ever folder load with one chat completes the same tap.
    await page.route("**/api/projects/fresh/threads", async (route) => {
      const discovered =
        f.store.threadByCodex("native-fresh") ??
        f.store.createThread("fresh", "native-fresh", "Свежий чат");
      await route.fulfill({ json: { threads: [discovered] } });
    });
    await open();
    await row("fresh").click();
    await expect(page.locator(".project-sheet")).not.toBeVisible();
    await expect
      .poll(() => f.store.preferences().threadId)
      .toBe(f.store.threadByCodex("native-fresh").id);
    await open();
    await expect(group("fresh").locator(".project-thread-list")).toHaveCount(0);
    await page.screenshot({
      animations: "disabled",
      path: `.local/qa-single-project/${engine}-phone.png`,
    });
    await page
      .getByRole("button", { name: "Закрыть проекты", exact: true })
      .filter({ visible: true })
      .click();
    await expect(page.locator(".project-sheet")).not.toBeVisible();
    await page.setViewportSize({ width: 1366, height: 1024 });
    await row("other").click();
    await expect(editor).toHaveValue("Второй черновик");
    await page.screenshot({
      animations: "disabled",
      path: `.local/qa-single-project/${engine}-tablet.png`,
    });
    assert.deepEqual(errors, []);
    assert.equal(f.calls.filter((c) => c.method === "turn/start").length, 0);
    assert.equal(f.desktopCalls.filter((c) => c !== "Status").length, 0);
    console.log(
      engine +
        ": direct single chat, first-load navigation, first New chat action, multiple-chat fold, stale load and retained drafts passed",
    );
  } finally {
    await context.close();
    await browser.close();
    await f.close();
  }
}
