import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, expect, webkit } from "@playwright/test";
import { guiPreviewFixture } from "./gui-preview-fixture.mjs";

for (const [engine, type] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
  const origin = "http://127.0.0.1:18879",
    f = await guiPreviewFixture(origin),
    browser = await type.launch(),
    context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      serviceWorkers: "block",
    });
  await f.release();
  f.store.setPreferences({
    projectId: "project",
    threadId: f.thread.id,
    theme: "classic-dark",
    view: "chat",
  });
  const [name, value] = f.headers.cookie.split("=");
  await context.addCookies([{ name, value, url: origin, httpOnly: true, sameSite: "Strict" }]);
  const page = await context.newPage(),
    errors = [],
    out = ".local/qa-gui-preview/" + engine;
  await mkdir(out, { recursive: true });
  page.on("pageerror", (e) => errors.push(e.message));
  const open = () =>
    page.evaluate(() =>
      window.dispatchEvent(
        new CustomEvent("open-gui-preview", {
          detail: { projectId: "project", projectName: "Project" },
        }),
      ),
    );
  const panel = page.getByRole("dialog", { name: "Предпросмотр приложения", exact: true });
  try {
    await f.app.listen({ host: "127.0.0.1", port: 18879 });
    await page.route("**/api/projects/project/files?**", (r) =>
      r.fulfill({ json: { entries: [], nextOffset: null, truncated: false } }),
    );
    await page.goto(origin);
    const chat = page.getByRole("textbox", { name: "Сообщение Codex" });
    await chat.fill("Черновик без изменений");
    await page.getByRole("button", { name: "Файлы проекта", exact: true }).click();
    await page.getByRole("button", { name: "Предпросмотр приложения", exact: true }).click();
    await expect(
      panel.getByRole("button", { name: "Открыть приложение", exact: true }),
    ).toBeEnabled();
    let lost = false;
    await page.route("**/api/projects/project/gui-previews/*", async (route) => {
      if (route.request().method() === "PUT" && !lost) {
        lost = true;
        await route.fetch();
        await route.abort("failed");
      } else await route.continue();
    });
    await panel.getByRole("button", { name: "Открыть приложение", exact: true }).click();
    await expect(panel.getByRole("alert")).toBeVisible();
    await panel.getByRole("button", { name: "Закрыть предпросмотр", exact: true }).click();
    await open();
    await panel.getByRole("button", { name: "Проверить запрос", exact: true }).click();
    await expect(panel.getByText("Ждём окно", { exact: true })).toBeVisible();
    assert.equal(f.previewCalls.filter((c) => c.q.op === "start").length, 1);
    const id = [...f.records.keys()][0];
    await panel.getByRole("button", { name: "Закрыть предпросмотр", exact: true }).click();
    f.capture(id);
    await expect
      .poll(
        () =>
          f.store.db
            .prepare("SELECT count(*) n FROM results WHERE sourceKey=?")
            .get("gui-preview:" + id).n,
        { timeout: 10000 },
      )
      .toBe(1);
    await open();
    await expect(panel.getByRole("button", { name: "Открыть снимок в результатах" })).toBeVisible();
    for (const theme of ["classic-dark", "organizer", "crt-green", "hitech-2000s"]) {
      await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
      for (const width of [390, 1366]) {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 1024 });
        assert(await panel.evaluate((el) => el.scrollWidth <= el.clientWidth));
        await page.screenshot({ path: `${out}/${theme}-${width}.png` });
      }
    }
    await panel.getByRole("button", { name: "Закрыть приложение", exact: true }).click();
    assert.equal(f.previewCalls.filter((c) => c.q.op === "stop").length, 0);
    await panel.getByRole("button", { name: "Отмена", exact: true }).click();
    assert.equal(f.records.get(id).appOpen, true);
    await panel.getByRole("button", { name: "Закрыть приложение", exact: true }).click();
    await panel
      .locator(".gui-preview-confirm")
      .getByRole("button", { name: "Закрыть приложение", exact: true })
      .click();
    await expect.poll(() => f.records.get(id).appOpen).toBe(false);
    await panel.getByRole("button", { name: "Открыть снимок в результатах" }).click();
    await expect(panel).not.toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Открыть приложение — окно приложения", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Открыть снимок", exact: true }).click();
    await page.getByRole("button", { name: "Развернуть предпросмотр", exact: true }).click();
    await expect(page.getByRole("dialog").last()).toBeVisible();
    await page
      .getByRole("dialog")
      .last()
      .getByRole("button", { name: "Закрыть снимок", exact: true })
      .click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page
      .getByRole("button", { name: "Чат", exact: true })
      .filter({ visible: true })
      .first()
      .click();
    await expect(chat).toHaveValue("Черновик без изменений");
    assert.equal(f.calls.filter((c) => c.method === "turn/start").length, 0);
    assert.deepEqual(errors, []);
    console.log(
      engine +
        " GUI preview: lost ack, background result, exact launch, confirmation, themes and preserved draft passed",
    );
  } finally {
    await context.close();
    await browser.close();
    await f.close();
  }
}
