import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, expect, webkit } from "@playwright/test";
import { Artifacts } from "../apps/hub/dist/artifacts.js";
import { communicationFixture } from "./communication-fixture.mjs";

const engine = process.env.BROWSER ?? "webkit",
  f = await communicationFixture(),
  browser = await (engine === "webkit" ? webkit : chromium).launch();
const contexts = [],
  errors = [];
async function client(headers) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    reducedMotion: "reduce",
    serviceWorkers: "allow",
  });
  contexts.push(context);
  const [name, value] = headers.cookie.split("=");
  await context.addCookies([{ name, value, url: f.base, httpOnly: true, sameSite: "Strict" }]);
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(f.base);
  return page;
}
async function open(page) {
  const drawer = page.getByRole("button", { name: "Открыть проекты", exact: true });
  if (await drawer.isVisible()) await drawer.click();
  await expect(
    page.locator(".workspace-shortcuts").getByRole("button", { name: "Отчёты", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Общение", exact: true }).last().click();
  await expect(page.locator(".communication-window[open]")).toBeVisible();
}
try {
  const owner = await client(f.headers),
    friend = await client(f.friendHeaders);
  await owner.bringToFront();
  await open(owner);
  const win = owner.locator(".communication-window");
  await win.getByRole("button", { name: "Новый разговор", exact: true }).click();
  await win.getByRole("button", { name: /Друг/, exact: false }).click();
  await win.getByRole("button", { name: "Начать разговор", exact: true }).click();
  const compose = win.getByRole("textbox", { name: "Сообщение участникам", exact: true });
  await compose.fill("Первое личное сообщение");
  await win.getByRole("button", { name: "Отправить в общий чат", exact: true }).click();
  await expect(win.locator(".space-chat-message")).toContainText("Первое личное сообщение");
  await compose.fill("Черновик остаётся на месте");
  await win.getByRole("button", { name: "Закрыть общение", exact: true }).click();
  await owner.getByRole("button", { name: "Общение", exact: true }).last().click();
  await win.getByRole("button", { name: "Друг", exact: true }).click();
  await expect(compose).toHaveValue("Черновик остаётся на месте");
  await friend.bringToFront();
  await open(friend);
  await friend.locator(".communication-list").getByRole("button", { name: /owner/ }).click();
  await expect(friend.locator(".space-chat-message")).toContainText("Первое личное сообщение");
  // Exact Result identity from the actual personal runtime, then public-room and DM grants.
  const runtime = f.runtimes.get("owner"),
    thread = runtime.thread.id;
  const file = new Artifacts(runtime.sessions.config.hub.resultsPath, runtime.store).putFile(
    thread,
    null,
    "interactive.html",
    "private.html",
    "text/html",
    Buffer.from("<button onclick=\"this.textContent='Работает'\">Проверить</button>"),
  );
  const resultId = runtime.store.result(
    thread,
    null,
    "share-demo",
    "file",
    "interactive.html",
    file,
  );
  const roomResponse = await f.request(f.headers, "POST", "/api/team/brainstorm", {
    title: "Большая общая комната для обсуждения нового проекта и материалов",
    description: "",
  });
  assert.equal(roomResponse.statusCode, 200, roomResponse.body);
  await owner.bringToFront();
  await win.getByRole("button", { name: "Закрыть общение", exact: true }).click();
  await owner.keyboard.press("Escape");
  await owner.reload();
  // Open exact captured Result using normal Results feed and share action.
  await owner.getByRole("button", { name: "Результаты", exact: true }).last().click();
  const card = owner.locator(`[data-result="${resultId}"]`);
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Отправить", exact: true }).click();
  const share = owner.locator(".result-share-window");
  await mkdir(".local/qa-communication", { recursive: true });
  await share.getByRole("button", { name: /Брейншторм · Большая/ }).click();
  await expect(share.getByRole("button", { name: "Отправить", exact: true })).toBeDisabled();
  await share.getByRole("checkbox").check();
  await expect(share.getByRole("button", { name: "Отправить", exact: true })).toBeEnabled();
  for (const theme of ["organizer", "crt-green", "hitech-2000s", "classic-dark"]) {
    await owner.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    await owner.screenshot({ path: `.local/qa-communication/${engine}-share-${theme}.png` });
    assert(await share.evaluate((el) => el.scrollWidth <= el.clientWidth + 1));
    const geometry = await share.evaluate((el) => {
      const audience = el.querySelector(".result-share-audience").getBoundingClientRect();
      const next = el.querySelector(".result-share-body > details").getBoundingClientRect();
      const input = el.querySelector(".result-share-audience input").getBoundingClientRect();
      return { audience: audience.bottom, next: next.top, input: input.width };
    });
    assert(geometry.next >= geometry.audience && geometry.input <= 24, JSON.stringify(geometry));
  }
  await share.getByRole("button", { name: "Отправить", exact: true }).click();
  await expect(share).toContainText("Результат отправлен.");
  await share.getByRole("button", { name: "Готово", exact: true }).click();
  await card.getByRole("button", { name: "Отправить", exact: true }).click();
  await share
    .getByRole("group", { name: "Пользователи Hub", exact: true })
    .getByRole("button", { name: /Друг/ })
    .click();
  await share.getByRole("button", { name: "Отправить", exact: true }).click();
  await expect(share).toContainText("Результат отправлен.");
  await share.getByRole("button", { name: "Готово", exact: true }).click();
  await friend.bringToFront();
  await friend
    .locator(".shared-result-card")
    .getByRole("button", { name: "Открыть результат", exact: true })
    .click();
  const iframe = friend.frameLocator(".shared-result-html");
  await iframe.getByRole("button", { name: "Проверить", exact: true }).click();
  await expect(iframe.getByRole("button")).toHaveText("Работает");
  assert.equal(
    await friend.locator(".shared-result-html").getAttribute("sandbox"),
    "allow-scripts",
  );
  await friend.getByRole("button", { name: "Закрыть просмотр", exact: true }).click();
  const friendWin = friend.locator(".communication-window");
  await friendWin
    .getByRole("textbox", { name: "Сообщение участникам", exact: true })
    .fill("Не потерять при просмотре");
  await mkdir(".local/qa-communication", { recursive: true });
  for (const size of [
    { width: 390, height: 844 },
    { width: 390, height: 500 },
    { width: 768, height: 1024 },
    { width: 1024, height: 768 },
    { width: 1366, height: 1024 },
  ]) {
    await friend.setViewportSize(size);
    await expect
      .poll(() =>
        friend.evaluate(() =>
          parseFloat(document.documentElement.style.getPropertyValue("--app-height")),
        ),
      )
      .toBe(size.height);
    for (const theme of ["organizer", "crt-green", "hitech-2000s", "classic-dark"]) {
      await friend.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
      const box = await friendWin.evaluate((el) => {
        const r = el.getBoundingClientRect(),
          c = el.querySelector('[aria-label="Закрыть общение"]').getBoundingClientRect();
        return {
          x: r.x,
          right: r.right,
          y: r.y,
          bottom: r.bottom,
          overflow: el.scrollWidth > el.clientWidth + 1,
          close: c.width,
        };
      });
      assert(
        box.x >= 0 &&
          box.right <= size.width &&
          box.y >= 0 &&
          box.bottom <= size.height &&
          !box.overflow &&
          box.close >= 44,
        JSON.stringify({ theme, size, box }),
      );
      await friend.screenshot({
        path: `.local/qa-communication/${engine}-${theme}-${size.width}x${size.height}.png`,
      });
    }
  }
  // Revoke only the direct grant while the recipient has its viewer open.
  await friendWin
    .locator(".shared-result-card")
    .getByRole("button", { name: "Открыть результат", exact: true })
    .click();
  await expect(friend.locator(".shared-result-html")).toBeVisible();
  await owner.bringToFront();
  await card.getByRole("button", { name: "Отправить", exact: true }).click();
  await share.getByText(/Куда отправлен ·/).click();
  await share
    .locator(".result-share-grant")
    .filter({ hasText: "Друг" })
    .getByRole("button", { name: "Отозвать", exact: true })
    .click();
  await expect(share.locator(".result-share-grant").filter({ hasText: "Друг" })).toContainText(
    "Доступ отозван",
  );
  await friend.bringToFront();
  await expect(friend.locator(".shared-result-html")).toHaveCount(0, { timeout: 15000 });
  await expect(friend.getByRole("alert")).toContainText(/отозван/i);
  const publicMessages = await f.request(
    f.thirdHeaders,
    "GET",
    `/api/team/brainstorm/${roomResponse.json().id}/chat`,
  );
  assert.equal(publicMessages.statusCode, 200, publicMessages.body);
  const publicGrant = publicMessages.json().messages[0].results[0].id;
  assert.equal(
    (await f.request(f.thirdHeaders, "GET", `/api/team/result-shares/${publicGrant}/content`))
      .statusCode,
    200,
  );
  assert.deepEqual(errors, []);
  console.log(
    `${engine}: two-user DM, draft restore, Results send, isolated interactive HTML and four-theme layouts passed`,
  );
} finally {
  await browser.close();
  await f.close();
}
