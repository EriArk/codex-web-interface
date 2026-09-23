import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, expect, webkit } from "@playwright/test";
import { handoffFixture } from "./handoff-fixture.mjs";

await mkdir(".local/qa-auth-startup", { recursive: true });
for (const [engine, type] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
  const origin = "http://127.0.0.1:18879",
    f = await handoffFixture(origin),
    browser = await type.launch();
  try {
    await f.app.listen({ host: "127.0.0.1", port: 18879 });
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      serviceWorkers: "block",
    });
    const [name, value] = f.headers.cookie.split("=");
    await context.addCookies([{ name, value, url: origin }]);
    const page = await context.newPage(),
      events = [];
    await page.exposeFunction("recordLogin", (data) => events.push(data));
    await page.addInitScript(() => {
      let reported = false;
      new MutationObserver(() => {
        const login = document.querySelector(".login-page");
        if (login && !reported) {
          reported = true;
          window.recordLogin({
            font: getComputedStyle(login).fontFamily,
            theme: document.documentElement.dataset.theme,
          });
        }
      }).observe(document, { childList: true, subtree: true });
    });
    const userId = "11111111-1111-4111-8111-111111111111";
    await page.route("**/api/auth/session", async (route) => {
      const response = await route.fetch();
      await route.fulfill({
        response,
        json: {
          ...(await response.json()),
          team: true,
          originalOwner: true,
          user: { id: userId, login: "owner", name: "Owner" },
        },
      });
    });
    let navigations = 0;
    await page.route(origin + "/", async (route) => {
      if (route.request().isNavigationRequest() && ++navigations === 2)
        await new Promise((resolve) => setTimeout(resolve, 750));
      await route.continue();
    });
    await page.goto(origin, { waitUntil: "commit" });
    await expect(page.getByLabel("Сообщение Codex", { exact: true })).toBeVisible();
    assert.equal(navigations, 2);
    assert.deepEqual(events, [], "an authenticated account handoff must not render the login form");
    assert.equal(
      await page.evaluate(() => sessionStorage.getItem("codex-workspace-identity")),
      userId,
    );
    await page.reload();
    await expect(page.getByLabel("Сообщение Codex", { exact: true })).toBeVisible();
    assert.deepEqual(events, [], "warm startup must not show login either");
    await context.close();
    const signedOut = await browser.newContext({
      viewport: { width: 390, height: 844 },
      serviceWorkers: "block",
    });
    const loginPage = await signedOut.newPage();
    await loginPage.route("**/api/auth/status", (route) =>
      route.fulfill({ json: { requiresSetup: false, team: true } }),
    );
    await loginPage.route("**/api/auth/login", async (route) => {
      // Exercise the team form against the fixture's actual password verifier.
      const response = await route.fetch({
        postData: JSON.stringify({ password: route.request().postDataJSON().password }),
      });
      await route.fulfill({ response });
    });
    await loginPage.route("**/*.css", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 350));
      await route.continue();
    });
    let unavailable = true;
    await loginPage.route("**/api/auth/session", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 350));
      if (unavailable)
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          json: { error: { code: "TRANSPORT_UNAVAILABLE", message: "Fixture unavailable" } },
        });
      else await route.continue();
    });
    await loginPage.goto(origin, { waitUntil: "domcontentloaded" });
    await expect(loginPage.locator(".boot-screen")).toBeVisible();
    await expect(loginPage.locator(".login-page")).toHaveCount(0);
    await expect(
      loginPage.getByRole("heading", { name: "Вернёмся к работе, когда появится связь." }),
    ).toBeVisible();
    await expect(loginPage.locator(".login-page")).toHaveCount(0);
    unavailable = false;
    await loginPage.getByRole("button", { name: "Попробовать снова" }).click();
    await expect(loginPage.locator(".login-page")).toBeVisible();
    for (const theme of ["organizer", "crt-green", "hitech-2000s", "classic-dark"]) {
      await loginPage.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
      for (const [width, height] of [
        [390, 844],
        [390, 430],
        [1366, 1024],
      ]) {
        await loginPage.setViewportSize({ width, height });
        await expect
          .poll(() =>
            loginPage.evaluate(() =>
              parseFloat(document.documentElement.style.getPropertyValue("--app-height")),
            ),
          )
          .toBe(height);
        assert(
          (
            await loginPage.locator(".login-page").evaluate((el) => getComputedStyle(el).fontFamily)
          ).includes("Roboto Condensed") || theme === "crt-green",
        );
        assert.equal(
          await loginPage.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false,
        );
        await loginPage.screenshot({
          path: `.local/qa-auth-startup/${engine}-${theme}-${width}x${height}.png`,
          animations: "disabled",
        });
      }
    }
    await loginPage.setViewportSize({ width: 390, height: 844 });
    await loginPage.getByLabel("Логин", { exact: true }).fill("owner");
    await loginPage.getByLabel("Пароль", { exact: true }).fill(f.password);
    await loginPage.getByRole("button", { name: "Войти", exact: true }).click();
    await expect(loginPage.getByLabel("Сообщение Codex", { exact: true })).toBeVisible();
    await signedOut.close();
    console.log(
      engine +
        ": cold/warm account handoff has no login flash; slow/failed session read, real 401 login, retry and themed layouts passed",
    );
  } finally {
    await browser.close();
    await f.close();
  }
}
