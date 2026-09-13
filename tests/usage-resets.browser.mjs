import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, expect, webkit } from "@playwright/test";
import { limits, usageFixture } from "./usage-resets-fixture.mjs";

for (const [engine, browserType] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
  const origin = "http://127.0.0.1:18929",
    f = await usageFixture(origin);
  f.store.setPreferences({
    projectId: "project",
    threadId: f.thread.id,
    view: "chat",
    theme: "hitech-2000s",
  });
  const browser = await browserType.launch(),
    context = await browser.newContext({
      viewport: { width: 393, height: 852 },
      hasTouch: true,
      reducedMotion: "reduce",
      serviceWorkers: "block",
    });
  const [name, value] = f.headers.cookie.split("=");
  await context.addCookies([{ name, value, url: origin, httpOnly: true, sameSite: "Strict" }]);
  const page = await context.newPage(),
    errors = [];
  let replacingDocument = false;
  page.on("pageerror", (error) => {
    // WebKit reports an in-flight fetch killed by the deliberate document replacement
    // as an access-control page error even though the request rejection is handled.
    if (
      engine === "webkit" &&
      replacingDocument &&
      error.message === "/127.0.0.1:18929/api/machines/pc/limits due to access control checks."
    )
      return;
    errors.push(error.message);
  });
  const reopen = async () => {
    replacingDocument = true;
    await page.reload({ waitUntil: "domcontentloaded" });
    await openSettings();
    await page.locator('.settings-browser[open] [data-category="connections"]').click();
    await expect(panel.getByText("Лимиты Codex", { exact: true })).toBeVisible();
    replacingDocument = false;
  };
  const button = (name) =>
    page.getByRole("button", { name, exact: true }).filter({ visible: true }).first();
  const panel = page.getByRole("region", { name: "Лимиты Codex: PC" }).filter({ visible: true });
  const reset = panel.locator(".usage-resets");
  const refresh = async () => {
    await page.evaluate(() => window.dispatchEvent(new Event("codex-usage-changed")));
    await expect(
      reset.getByRole("button", { name: "Активировать", exact: true }).first(),
    ).toBeEnabled();
  };
  const nextAccount = () => {
    f.state.raw = limits();
    f.state.raw.accountId = "browser-" + Math.random();
    f.state.mode = "normal";
  };
  const openSettings = async () => {
    if (!(await button("Настройки").isVisible())) await button("Открыть проекты").click();
    await button("Настройки").click();
  };
  const out = `.local/qa-usage-resets/${engine}`;
  await mkdir(out, { recursive: true });
  try {
    await f.app.listen({ port: 18929, host: "127.0.0.1" });
    await page.goto(origin);
    const draft = page.getByRole("textbox", { name: "Сообщение Codex" });
    await draft.fill("Черновик должен сохраниться после сброса лимитов");
    await openSettings();
    await expect(panel.getByText("37% осталось", { exact: true })).toBeVisible();
    await expect(panel.locator(".usage-reset-count")).toHaveText("2");
    // The overview and Connections reuse a single poller, and the same canonical snapshot.
    let usageReads = 0;
    page.on("request", (r) => {
      if (new URL(r.url()).pathname === "/api/machines/pc/limits") usageReads++;
    });
    await page.locator('.settings-browser[open] [data-category="connections"]').click();
    await expect(panel.getByText("37% осталось", { exact: true })).toBeVisible();
    await expect(reset.locator(".usage-reset-count")).toHaveText("2");
    assert.equal(usageReads, 0, "Entering Connections does not refetch the same snapshot");
    await reset.getByRole("button", { name: "Активировать", exact: true }).first().click();
    const confirm = reset.getByRole("group", { name: "Подтверждение сброса" });
    await expect(confirm).toBeVisible();
    await confirm.getByRole("button", { name: "Отмена", exact: true }).click();
    assert.equal(f.state.consumes.length, 0);
    for (const width of [393, 1366]) {
      await page.setViewportSize({ width, height: width === 393 ? 852 : 1024 });
      for (const theme of ["hitech-2000s", "crt-green", "organizer", "classic-dark"]) {
        await page.evaluate((t) => {
          document.documentElement.dataset.theme = t;
        }, theme);
        await reset.scrollIntoViewIfNeeded();
        await page.evaluate(() => document.fonts.ready);
        assert(
          await panel.evaluate((e) => e.scrollWidth <= e.clientWidth + 2),
          `${theme}/${width} overflow`,
        );
        for (const b of await reset.getByRole("button").all())
          assert((await b.boundingBox()).height >= 44, "touch target");
        await panel.screenshot({ path: `${out}/${theme}-${width}.png`, animations: "disabled" });
      }
    }
    await page.setViewportSize({ width: 393, height: 852 });
    await reset.getByRole("button", { name: "Активировать", exact: true }).first().click();
    await confirm.getByRole("button", { name: "Использовать сброс", exact: true }).click();
    await expect(reset.getByText("Сброс активирован.", { exact: true })).toBeVisible();
    await expect(panel.getByText("100% осталось", { exact: true })).toHaveCount(2);
    await expect(reset.locator(".usage-reset-count")).toHaveText("1");
    assert.equal(f.state.consumes.length, 1);
    await button("Закрыть настройки").click();
    await expect(draft).toHaveValue("Черновик должен сохраниться после сброса лимитов");
    await openSettings();
    await expect(panel.getByText("100% осталось", { exact: true })).toHaveCount(2);
    await expect(reset.locator(".usage-reset-count")).toHaveText("1");
    // Start from the main view, navigate while native redemption is pending, never spend twice.
    let release;
    f.state.hold = new Promise((resolve) => {
      release = resolve;
    });
    await reset.getByRole("button", { name: "Активировать", exact: true }).first().click();
    await confirm.getByRole("button", { name: "Использовать сброс", exact: true }).click();
    await expect.poll(() => f.state.consumes.length).toBe(2);
    await page.locator('.settings-browser[open] [data-category="connections"]').click();
    await expect(
      reset.getByRole("button", { name: "Активировать", exact: true }).first(),
    ).toBeDisabled();
    release();
    f.state.hold = null;
    await expect(reset.getByText("Доступных сбросов нет.", { exact: true })).toBeVisible();
    assert.equal(f.state.consumes.length, 2);

    // Failed HTTP acknowledgement: Hub/native succeeded; reopen only reads receipt.
    nextAccount();
    await refresh();
    await page.route(
      "**/api/machines/pc/limits/resets",
      async (route) => {
        await route.fetch();
        await route.abort("failed");
      },
      { times: 1 },
    );
    const before = f.state.consumes.length;
    await reset.getByRole("button", { name: "Активировать", exact: true }).first().click();
    await confirm.getByRole("button", { name: "Использовать сброс", exact: true }).click();
    await expect.poll(() => f.state.consumes.length).toBe(before + 1);
    await reopen();
    await expect(reset.getByText("Сброс активирован.", { exact: true })).toBeVisible();
    assert.equal(f.state.consumes.length, before + 1);

    // Native receipt lost after debit: show unknown and explicitly retry the same key.
    nextAccount();
    await refresh();
    f.state.mode = "lose-after";
    await reset.getByRole("button", { name: "Активировать", exact: true }).first().click();
    await confirm.getByRole("button", { name: "Использовать сброс", exact: true }).click();
    await expect(
      reset.getByText("Исход сброса пока не подтверждён.", { exact: true }),
    ).toBeVisible();
    const key = f.state.consumes.at(-1).idempotencyKey;
    await reopen();
    await expect(
      reset.getByRole("button", { name: "Проверить попытку", exact: true }),
    ).toBeEnabled();
    f.state.mode = "normal";
    await reset.getByRole("button", { name: "Проверить попытку", exact: true }).click();
    await expect(
      reset.getByText("Эта попытка уже активировала сброс.", { exact: true }),
    ).toBeVisible();
    assert.equal(f.state.consumes.at(-1).idempotencyKey, key);
    assert.equal(f.state.raw.rateLimitResetCredits.availableCount, 1);

    nextAccount();
    f.state.raw.rateLimitResetCredits.credits = null;
    await page.evaluate(() => window.dispatchEvent(new Event("codex-usage-changed")));
    await expect(
      reset.getByRole("button", { name: "Использовать один", exact: true }),
    ).toBeEnabled();
    await reset.getByRole("button", { name: "Использовать один", exact: true }).click();
    await confirm.getByRole("button", { name: "Использовать сброс", exact: true }).click();
    await expect(reset.getByText("Сброс активирован.", { exact: true })).toBeVisible();
    assert(!("creditId" in f.state.consumes.at(-1)));

    nextAccount();
    f.state.raw.rateLimitResetCredits.credits[0].expiresAt = 1;
    f.state.raw.rateLimitResetCredits.credits[1].status = "redeemed";
    await page.evaluate(() => window.dispatchEvent(new Event("codex-usage-changed")));
    await expect(
      reset.getByText("Список доступных сбросов пока не подтверждён.", { exact: true }),
    ).toBeVisible();
    assert.equal(await reset.getByRole("button", { name: "Активировать", exact: true }).count(), 0);

    nextAccount();
    await refresh();
    f.state.mode = "unsupported";
    await reset.getByRole("button", { name: "Активировать", exact: true }).first().click();
    await confirm.getByRole("button", { name: "Использовать сброс", exact: true }).click();
    await expect(
      reset
        .getByText("Эта версия Codex не поддерживает активацию сброса.", { exact: true })
        .first(),
    ).toBeVisible();
    await expect(panel.getByText("37% осталось", { exact: true })).toBeVisible();

    nextAccount();
    f.state.raw.rateLimitResetCredits.availableCount = 0;
    f.state.raw.rateLimitResetCredits.credits = [];
    await page.evaluate(() => window.dispatchEvent(new Event("codex-usage-changed")));
    await expect(reset.getByText("Доступных сбросов нет.", { exact: true })).toBeVisible();
    assert.equal(await reset.getByRole("button", { name: "Активировать", exact: true }).count(), 0);
    nextAccount();
    delete f.state.raw.rateLimitResetCredits;
    await page.evaluate(() => window.dispatchEvent(new Event("codex-usage-changed")));
    await expect(reset).toHaveCount(0);
    await expect(panel.getByText("37% осталось", { exact: true })).toBeVisible();
    await button("Все категории настроек").click();
    await expect(reset).toHaveCount(0);
    await expect(panel.getByText("37% осталось", { exact: true })).toBeVisible();
    for (const variant of ["zero", "count", "detailed"]) {
      nextAccount();
      if (variant === "zero") {
        f.state.raw.rateLimitResetCredits.availableCount = 0;
        f.state.raw.rateLimitResetCredits.credits = [];
      }
      if (variant === "count") f.state.raw.rateLimitResetCredits.credits = null;
      await page.evaluate(() => window.dispatchEvent(new Event("codex-usage-changed")));
      if (variant === "zero")
        await expect(reset.getByText("Доступных сбросов нет.", { exact: true })).toBeVisible();
      else if (variant === "count")
        await expect(
          reset.getByRole("button", { name: "Использовать один", exact: true }),
        ).toBeEnabled();
      else
        await expect(
          reset.getByRole("button", { name: "Активировать", exact: true }).first(),
        ).toBeEnabled();
    }
    for (const width of [320, 768, 1366, 1920]) {
      await page.setViewportSize({ width, height: width < 760 ? 852 : 1024 });
      for (const theme of ["hitech-2000s", "crt-green", "organizer", "classic-dark"]) {
        await page.evaluate((theme) => {
          document.documentElement.dataset.theme = theme;
        }, theme);
        await panel.scrollIntoViewIfNeeded();
        assert(
          await panel.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
          `${theme}/${width} summary overflow`,
        );
        await panel.screenshot({
          path: `${out}/summary-${theme}-${width}.png`,
          animations: "disabled",
        });
      }
    }
    assert.deepEqual(errors, []);
    assert(f.desktopCalls.every((action) => action === "Status"));
    assert(!f.calls.some((c) => ["turn/start", "turn/steer", "turn/interrupt"].includes(c.method)));
    console.log(
      `${engine}: reset confirmation, canonical meters, HTTP/native lost receipts, reload, count-only, expiry, legacy, four themes and phone/tablet passed`,
    );
  } finally {
    await browser.close();
    await f.close();
  }
}
