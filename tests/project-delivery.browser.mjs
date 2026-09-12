import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, expect, webkit } from "@playwright/test";
import { deliveryFixture, deliveryState } from "./delivery-fixture.mjs";

for (const [engine, type] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
  const origin = "http://127.0.0.1:18877",
    f = await deliveryFixture(origin),
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
    out = ".local/qa-delivery/" + engine;
  await mkdir(out, { recursive: true });
  page.on("pageerror", (e) => errors.push(e.message));
  const open = () =>
    page.evaluate(() =>
      window.dispatchEvent(
        new CustomEvent("open-project-delivery", {
          detail: { projectId: "project", projectName: "Project" },
        }),
      ),
    );
  try {
    await f.app.listen({ host: "127.0.0.1", port: 18877 });
    await page.route("**/api/projects/project/files?**", (r) =>
      r.fulfill({ json: { entries: [], nextOffset: null, truncated: false } }),
    );
    await page.route("**/api/projects/project/git", (r) =>
      r.fulfill({
        json: {
          repository: true,
          branch: "feature/mobile",
          detached: false,
          changes: [],
          commits: [],
          hiddenCount: 0,
          dirty: true,
        },
      }),
    );
    await page.route("**/api/projects/project/git/**", (r) =>
      r.fulfill({
        json: {
          state: "ok",
          items: [],
          repository: true,
          name: "Project",
          readme: null,
          branches: [],
          tags: [],
          text: "+reviewed source",
          path: "app.ts",
          staged: false,
          truncated: false,
        },
      }),
    );
    await page.goto(origin);
    const chat = page.getByRole("textbox", { name: "Сообщение Codex" });
    await chat.fill("Основной черновик остаётся");
    await page.getByRole("button", { name: "Файлы и Git проекта", exact: true }).click();
    const files = page.getByRole("region", { name: "Файлы и Git", exact: true });
    await files.getByRole("button", { name: "Git", exact: true }).click();
    await files.getByRole("button", { name: "Доставка", exact: true }).click();
    const panel = page.getByRole("dialog", { name: "Доставка проекта", exact: true });
    await expect(panel.getByRole("checkbox").first()).toBeVisible();
    await panel.getByRole("checkbox").first().check();
    await panel
      .getByRole("textbox", { name: "Сообщение коммита", exact: true })
      .fill("Мобильная навигация");
    await panel.getByRole("button", { name: "Закрыть доставку" }).click();
    await files.getByRole("button", { name: "Вернуться к чату" }).click();
    await expect(chat).toHaveValue("Основной черновик остаётся");
    await open();
    await expect(
      panel.getByRole("textbox", { name: "Сообщение коммита", exact: true }),
    ).toHaveValue("Мобильная навигация");
    await expect(panel.getByRole("checkbox").first()).toBeChecked();
    let lost = false;
    await page.route("**/api/projects/project/delivery/*", async (route) => {
      if (route.request().method() === "PUT" && !lost) {
        lost = true;
        await route.fetch();
        await route.abort("failed");
      } else await route.continue();
    });
    await panel.getByRole("button", { name: "Просмотреть коммит" }).click();
    await expect(panel.getByRole("alert")).toBeVisible();
    await panel.getByRole("button", { name: "Закрыть доставку" }).click();
    await open();
    await panel.getByRole("button", { name: "Проверить подготовку" }).click();
    await expect(panel.getByRole("button", { name: "Подтвердить коммит" })).toBeVisible();
    assert.equal(f.deliveryCalls.filter((c) => c.request.op === "apply").length, 0);
    await panel.getByRole("button", { name: "Подтвердить коммит" }).click();
    await expect(panel.locator(".delivery-operation")).toHaveAttribute("data-state", "completed", {
      timeout: 12000,
    });
    assert.equal(f.deliveryCalls.filter((c) => c.request.op === "apply").length, 1);
    await panel.getByRole("button", { name: "Продолжить", exact: true }).click();
    await panel.getByRole("button", { name: "Попросить Codex исправить CI" }).click();
    await expect(panel.getByRole("region", { name: "Задание проекта" })).toContainText(
      "Исправить CI",
    );
    assert.equal(f.calls.filter((c) => c.method === "turn/start").length, 0);
    // The owner opens a different project while the previous bounded read is still pending.
    await panel.getByRole("button", { name: "Закрыть доставку" }).click();
    let release;
    const wait = new Promise((r) => {
      release = r;
    });
    await page.route("**/api/projects/project/delivery", async (route) => {
      await wait;
      await route.continue();
    });
    await open();
    await page.route("**/api/projects/other/delivery", (r) =>
      r.fulfill({
        json: {
          id: "other-read",
          projectId: "other",
          projectName: "Other",
          createdAt: Date.now(),
          state: {
            ...deliveryState(),
            branch: "other-branch",
            upstream: "origin/other-branch",
            github: { state: "no-remote", checks: [] },
          },
        },
      }),
    );
    await page.route("**/api/projects/other/delivery/operations", (r) =>
      r.fulfill({ json: { items: [] } }),
    );
    await page.evaluate(() =>
      window.dispatchEvent(
        new CustomEvent("open-project-delivery", {
          detail: { projectId: "other", projectName: "Other" },
        }),
      ),
    );
    await expect(panel.locator(".delivery-summary")).toContainText("other-branch");
    release();
    await expect(panel.locator(".delivery-summary")).not.toContainText("feature/mobile");
    await panel.getByRole("button", { name: "Закрыть доставку" }).click();
    await page.unroute("**/api/projects/project/delivery");
    // Change theme through the real Settings control; render the same modal on phone and tablet.
    for (const theme of ["classic-dark", "organizer", "hitech-2000s", "crt-green"]) {
      await page
        .getByRole("button", { name: "Настройки", exact: true })
        .filter({ visible: true })
        .click();
      await page.locator('.settings-browser[open] [data-category="appearance"]').click();
      const settings = page.locator(".settings-dialog[open]");
      await settings.locator(".theme-option." + theme + " input").check();
      await settings.getByRole("button", { name: "Закрыть настройки" }).click();
      await open();
      for (const [width, height] of [
        [1366, 1024],
        [390, 844],
      ]) {
        await page.setViewportSize({ width, height });
        await expect(panel.getByRole("heading", { name: "Доставка", exact: true })).toBeVisible();
        await panel.locator(".delivery-scroll").evaluate((e) => (e.scrollTop = 0));
        assert(await panel.evaluate((e) => e.scrollWidth <= e.clientWidth + 2));
        await page.screenshot({
          path: out + "/" + theme + "-" + width + ".png",
          animations: "disabled",
        });
      }
      await panel.getByRole("button", { name: "Закрыть доставку" }).click();
    }
    await open();
    await page.setViewportSize({ width: 390, height: 430 });
    await expect(panel.getByRole("button", { name: "Закрыть доставку" })).toBeInViewport();
    await panel.getByRole("button", { name: "Закрыть доставку" }).click();
    await expect(chat).toHaveValue("Основной черновик остаётся");
    assert.deepEqual(errors, []);
    console.log(
      engine +
        ": scoped delivery, immutable review, lost acknowledgement, drafts, CI preparation and four themes passed",
    );
  } catch (e) {
    console.error(errors);
    console.error((await page.locator("body").innerText()).slice(-9000));
    await page.screenshot({ path: out + "/failure.png" });
    throw e;
  } finally {
    await context.close();
    await browser.close();
    await f.close();
  }
}
