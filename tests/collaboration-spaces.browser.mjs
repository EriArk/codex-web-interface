import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, webkit } from "@playwright/test";
import { createApp } from "../apps/hub/dist/app.js";
import { Sessions } from "../apps/hub/dist/sessions.js";
import { Store } from "../apps/hub/dist/store.js";
import { teamPasswordHash } from "../apps/hub/dist/team-auth.js";
import { createTeamHub } from "../apps/hub/dist/team-hub.js";
import { configSchema } from "../packages/shared/dist/index.js";
import { capabilityReply } from "./fixtures.mjs";

const root = await mkdtemp(join(tmpdir(), "cw-spaces-ui-")),
  probe = createServer();
await new Promise((done) => probe.listen(0, "127.0.0.1", done));
const port = probe.address().port;
await new Promise((done) => probe.close(done));
const base = `http://127.0.0.1:${port}`,
  password = randomBytes(24).toString("base64url");
const config = configSchema.parse({
  hub: {
    publicBaseUrl: base,
    secureCookies: false,
    databasePath: join(root, "owner.db"),
    resultsPath: join(root, "files"),
  },
  team: { enabled: true, root: join(root, "team") },
  auth: { username: "owner" },
  machines: [],
  projects: [],
});
const store = new Store(config.hub.databasePath);
store.db.prepare("INSERT INTO users VALUES(?,?)").run("owner", await teamPasswordHash(password));
const runtimes = new Map();
const hub = await createTeamHub(config, {
  store,
  socketRoot: join(root, "sock"),
  webRoot: resolve("apps/web/dist"),
  personalFactory: async (selected, options) => {
    const who = selected.auth.username,
      path = join(root, who);
    await mkdir(path, { recursive: true });
    execFileSync("git", ["init", "-q", path]);
    execFileSync("git", [
      "-C",
      path,
      "remote",
      "add",
      "origin",
      `https://github.com/example/${who === "owner" ? "altar" : "world"}.git`,
    ]);
    const extra = join(root, who + "-extra");
    await mkdir(extra);
    execFileSync("git", ["init", "-q", extra]);
    execFileSync("git", [
      "-C",
      extra,
      "remote",
      "add",
      "origin",
      `https://github.com/example/${who === "owner" ? "assets" : "altar"}.git`,
    ]);
    const cfg = configSchema.parse({
      ...selected,
      machines: [{ id: "pc", name: "Local", type: "local-linux", allowedRoots: [root] }],
      projects: [
        {
          id: who + "-extra",
          name: who === "owner" ? "Assets" : "Altar copy",
          machineId: "pc",
          workingDirectory: extra,
        },
        {
          id: who + "-project",
          name: who === "owner" ? "Altar" : "World",
          machineId: "pc",
          workingDirectory: path,
        },
      ],
    });
    const personalStore = options.store ?? new Store(cfg.hub.databasePath);
    const nativeId = randomUUID(),
      thread = personalStore.createThread(who + "-project", nativeId, "Existing " + who + " chat");
    const rpc = Object.assign(new EventEmitter(), {
      closed: false,
      initialize: async () => ({}),
      close() {
        this.closed = true;
      },
      async request(method, params) {
        const capabilities = capabilityReply(method);
        if (capabilities) return capabilities;
        if (method === "account/read") return { account: { type: "chatgpt" } };
        if (method === "thread/read" || method === "thread/resume")
          return { thread: { id: params.threadId, turns: [] } };
        return { data: [], nextCursor: null };
      },
    });
    const sessions = new Sessions(cfg, personalStore, () => rpc);
    sessions.externalActivity.refresh = async () => {};
    const runtime = await createApp(cfg, { ...options, sessions, store: personalStore });
    runtimes.set(who, { ...runtime, thread, nativeId });
    return runtime;
  },
});
await hub.app.listen({ host: "127.0.0.1", port });
const friend = hub.registry.accept(
  hub.registry.invite(hub.registry.ownerId, "Друг").token,
  "friend",
  "Друг",
  await teamPasswordHash(password),
  10,
);
hub.registry.db
  .prepare("INSERT INTO team_meta(key,value) VALUES(?,?)")
  .run(`onboarding:${friend.id}`, "deferred");
const browser = await webkit.launch();
const ownerContext = await browser.newContext({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  serviceWorkers: "block",
});
const friendContext = await browser.newContext({
  viewport: { width: 1024, height: 768 },
  hasTouch: true,
  serviceWorkers: "block",
});
const page = await ownerContext.newPage(),
  other = await friendContext.newPage(),
  errors = [];
page.setDefaultTimeout(20000);
other.setDefaultTimeout(20000);
for (const p of [page, other]) p.on("pageerror", (e) => errors.push(e.message));
async function login(p, user) {
  await p.goto(base);
  await p.getByLabel("Логин", { exact: true }).fill(user);
  await p.getByLabel("Пароль", { exact: true }).fill(password);
  await p.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(p.locator(".login-page")).toHaveCount(0);
  const later = p.getByRole("button", { name: "Позже", exact: true });
  if (await later.isVisible()) await later.click();
}
async function drawer(p) {
  if (!(await p.locator(".navigation-inner:visible").count()))
    await p.getByRole("button", { name: "Открыть проекты", exact: true }).click();
  return p.locator(".navigation-inner:visible").last();
}
try {
  await login(page, "owner");
  await login(other, "friend");
  await page.bringToFront();
  const nav = await drawer(page);
  assert.equal(
    await nav.locator(".nav-mobile-switch > button").nth(1).getAttribute("class"),
    "icon-button space-mode-toggle",
  );
  await expect(nav.locator(".workspace-shortcuts .space-bell")).toHaveText("Уведомления");
  await expect(nav.locator(".navigation-header .space-bell")).toHaveCount(0);
  await nav.getByRole("button", { name: "Общие пространства", exact: true }).click();
  await nav.getByRole("button", { name: "Создать пространство", exact: true }).click();
  let dialog = page.locator(".space-dialog");
  await mkdir(".local/spaces-qa", { recursive: true });
  await dialog.getByLabel("Название", { exact: true }).fill("Altar + World");
  await page.bringToFront();
  await dialog.getByRole("button", { name: /^Пространство Связанные/ }).click();
  await dialog.getByRole("button", { name: "Далее", exact: true }).click();
  await dialog.getByLabel("Мой проект", { exact: true }).selectOption("owner-project");
  // Existing Project wizard opens above this one; cancellation preserves selection and step.
  await dialog.getByRole("button", { name: "Создать проект", exact: true }).click();
  await expect(page.locator(".project-setup-dialog[open]")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog.getByLabel("Мой проект", { exact: true })).toHaveValue("owner-project");
  await dialog
    .getByRole("group", { name: "Пользователи Hub", exact: true })
    .getByRole("button", { name: /Друг/ })
    .click();
  await dialog.getByRole("button", { name: "Далее", exact: true }).click();
  await dialog.getByLabel("Запросить доступ к проекту участника").selectOption("direct");
  await dialog.getByRole("button", { name: "Далее", exact: true }).click();
  await dialog.getByRole("button", { name: "Пригласить", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(nav.locator(".space-selected")).toContainText("Altar + World");
  await nav.getByRole("button", { name: "Личные проекты", exact: true }).click();
  await expect(nav.locator('[data-project-id="owner-project"]')).toHaveCount(0);
  await other.reload();
  const otherNav = await drawer(other);
  await otherNav.getByRole("button", { name: "Уведомления: 1", exact: true }).click();
  await other
    .locator(".space-dialog")
    .getByRole("button", { name: /Altar \+ World/ })
    .click();
  dialog = other.locator(".space-dialog");
  await dialog.getByRole("button", { name: "Далее", exact: true }).click();
  await dialog.getByLabel("Мой проект", { exact: true }).selectOption("friend-project");
  await dialog.getByRole("button", { name: "Далее", exact: true }).click();
  await dialog.getByLabel(/Доступ для .* к моему проекту/).selectOption("collaborate");
  await dialog.getByRole("button", { name: "Далее", exact: true }).click();
  await dialog.getByRole("button", { name: "Присоединиться", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(otherNav.locator('[data-project-id="friend-project"]')).toBeVisible();
  await otherNav.locator('[data-project-id="friend-project"]').click();
  await expect(other.locator(".project-sheet[open]")).toHaveCount(0);
  assert.equal(
    runtimes.get("friend").store.thread(runtimes.get("friend").thread.id).codexThreadId,
    runtimes.get("friend").nativeId,
  );
  await drawer(other);
  await otherNav.getByRole("button", { name: "Настройки пространства", exact: true }).click();
  const settings = other.locator(".space-dialog");
  await settings.locator("summary").filter({ hasText: "Altar" }).click();
  await settings.getByRole("button", { name: "Подключить мою копию", exact: true }).click();
  await settings.getByLabel("Проект для подключения", { exact: true }).selectOption("friend-extra");
  await settings.getByRole("button", { name: "Подключить", exact: true }).click();
  await expect(
    settings.getByRole("button", { name: "Сменить рабочую копию", exact: true }),
  ).toBeVisible();
  await settings.getByRole("button", { name: "Запросить прямой доступ", exact: true }).click();
  await expect(settings).toContainText("Прямой доступ запрошен");
  await page.evaluate(() => globalThis.dispatchEvent(new Event("focus")));
  await nav.getByRole("button", { name: "Уведомления: 1", exact: true }).click();
  await page
    .locator(".space-dialog")
    .getByRole("button", { name: /Altar.*просит прямой доступ/ })
    .click();
  const ownerSettings = page.locator(".space-dialog");
  await ownerSettings.locator("summary").filter({ hasText: "Altar" }).click();
  await ownerSettings.getByRole("button", { name: "Разрешить", exact: true }).click();
  await expect(ownerSettings.getByLabel("Доступ: Altar · Друг", { exact: true })).toHaveValue(
    "direct",
  );
  await ownerSettings.getByRole("button", { name: "Добавить свой проект", exact: true }).click();
  await ownerSettings
    .getByLabel("Проект для подключения", { exact: true })
    .selectOption("owner-extra");
  await ownerSettings.getByRole("button", { name: "Подключить", exact: true }).click();
  await ownerSettings.locator("summary").filter({ hasText: "Assets" }).click();
  await ownerSettings
    .locator("details")
    .filter({ hasText: "Assets" })
    .getByRole("button", { name: "Убрать из пространства" })
    .click();
  await ownerSettings.getByRole("button", { name: "Убрать", exact: true }).click();
  await expect(ownerSettings.locator("summary").filter({ hasText: "Assets" })).toHaveCount(0);
  await page.screenshot({ path: ".local/spaces-qa/project-access-phone.png" });
  await other.evaluate(() => globalThis.dispatchEvent(new Event("focus")));
  await expect(settings.locator("summary").filter({ hasText: "Altar" })).toContainText(
    "Прямая работа",
  );
  await other.screenshot({ path: ".local/spaces-qa/project-access-tablet.png" });
  // Human chat is a separate popup: files, live replies, exact-send retry and unread badges.
  await ownerSettings.getByLabel("Закрыть пространство", { exact: true }).click();
  await settings.getByLabel("Закрыть пространство", { exact: true }).click();
  await nav.getByRole("button", { name: "Общие пространства", exact: true }).click();
  await expect(nav.locator(".nav-mobile-switch > button").nth(0)).toHaveText("Пространства");
  await expect(nav.locator(".nav-mobile-switch > button").nth(2)).toHaveText("Брейншторм");
  await nav.getByRole("button", { name: "Брейншторм", exact: true }).click();
  await expect(nav).toContainText("комнаты для совместного обсуждения идей");
  await nav.getByRole("button", { name: "Пространства", exact: true }).click();
  for (const width of [390, 768, 1024, 1366]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1024 });
    const visibleNav = await drawer(page);
    for (const theme of ["organizer", "crt-green", "hitech-2000s", "classic-dark"]) {
      await page.evaluate((t) => {
        document.documentElement.dataset.theme = t;
      }, theme);
      const layout = await visibleNav.locator(".nav-mobile-switch").evaluate((el) => {
        const buttons = [...el.children],
          cap = buttons[1].getBoundingClientRect();
        const left = buttons[0].querySelector(".nav-tab-title").getBoundingClientRect();
        const right = buttons[2].querySelector(".nav-tab-title").getBoundingClientRect();
        return {
          width: cap.width,
          height: cap.height,
          overlap: left.right > cap.left + 5 || right.left < cap.right - 5,
          overflows: el.scrollWidth > el.clientWidth + 1,
          left: left.right,
          right: right.left,
          capLeft: cap.left,
          capRight: cap.right,
        };
      });
      assert.equal(layout.width, 85);
      assert.equal(layout.height, 80);
      assert.ok(!layout.overlap && !layout.overflows, JSON.stringify({ width, theme, layout }));
      if (width === 390 || width === 1024)
        await page.screenshot({ path: `.local/spaces-qa/navigation-${width}-${theme}.png` });
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await drawer(page);
  await nav.getByRole("button", { name: /^Чат: Altar/ }).click();
  const chat = page.locator(".space-chat-dialog");
  await chat.getByLabel("Сообщение участникам").fill("План работ https://example.com/plan");
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8yoAAAAASUVORK5CYII=",
    "base64",
  );
  await chat.locator('input[type="file"]').setInputFiles([
    { name: "схема.png", mimeType: "image/png", buffer: png },
    { name: "план.txt", mimeType: "text/plain", buffer: Buffer.from("Наш план") },
  ]);
  await expect(chat.getByRole("button", { name: "Убрать план.txt" })).toBeVisible();
  await chat.getByRole("button", { name: "Отправить в общий чат" }).click();
  await expect(chat.locator(".space-chat-message")).toHaveCount(1);
  await expect(
    chat.locator('.space-chat-message a[href="https://example.com/plan"]'),
  ).toBeVisible();
  await expect
    .poll(() => chat.locator(".space-chat-file img").evaluate((el) => el.naturalWidth))
    .toBe(1);
  const download = await ownerContext.request.get(
    await chat.getByRole("link", { name: /план.txt/ }).getAttribute("href"),
  );
  assert.equal((await download.body()).toString(), "Наш план");
  await other.evaluate(() => globalThis.dispatchEvent(new Event("focus")));
  await expect(otherNav.getByRole("button", { name: "Уведомления: 1", exact: true })).toBeVisible();
  await otherNav.getByRole("button", { name: /^Чат: Altar/ }).click();
  const otherChat = other.locator(".space-chat-dialog");
  await expect(otherChat.locator(".space-chat-message")).toHaveCount(1);
  await expect(otherNav.locator(".space-bell small")).toHaveCount(0);
  await otherChat.getByLabel("Сообщение участникам").fill("Взял world в работу");
  await otherChat.getByRole("button", { name: "Отправить в общий чат" }).click();
  await expect(chat).toContainText("Взял world в работу", { timeout: 10000 });
  await chat.getByLabel("Сообщение участникам").fill("Черновик общего чата");
  for (const theme of ["organizer", "crt-green", "hitech-2000s", "classic-dark"]) {
    await page.evaluate((t) => {
      document.documentElement.dataset.theme = t;
    }, theme);
    const bounds = await chat.evaluate((el) => {
      document.documentElement.dataset.keyboard = "true";
      document.documentElement.style.setProperty("--app-height", "400px");
      const r = el.getBoundingClientRect(),
        input = el.querySelector("textarea").getBoundingClientRect();
      const value = {
        top: r.top,
        bottom: r.bottom,
        inputBottom: input.bottom,
        overflow: el.scrollWidth > el.clientWidth + 1,
      };
      delete document.documentElement.dataset.keyboard;
      document.documentElement.style.setProperty("--app-height", "844px");
      return value;
    });
    assert.ok(
      bounds.top >= 0 && bounds.bottom <= 401 && bounds.inputBottom <= 401 && !bounds.overflow,
      JSON.stringify({ theme, bounds }),
    );
    await page.screenshot({ path: `.local/spaces-qa/chat-phone-${theme}.png` });
  }
  await other.screenshot({ path: ".local/spaces-qa/chat-tablet.png" });
  await chat.getByLabel("Закрыть пространство", { exact: true }).click();
  await nav.getByRole("button", { name: /^Чат: Altar/ }).click();
  await expect(chat.getByLabel("Сообщение участникам")).toHaveValue("Черновик общего чата");
  await chat.getByLabel("Закрыть пространство", { exact: true }).click();
  await otherChat.getByLabel("Закрыть пространство", { exact: true }).click();
  await otherNav.getByRole("button", { name: "Настройки пространства", exact: true }).click();
  await other
    .locator(".space-dialog")
    .getByRole("button", { name: "Выйти из пространства", exact: true })
    .click();
  await other.locator(".space-dialog").getByRole("button", { name: "Выйти", exact: true }).click();
  await expect(other.locator(".space-dialog")).toHaveCount(0);
  await otherNav.getByRole("button", { name: "Личные проекты", exact: true }).click();
  await expect(otherNav.locator('[data-project-id="friend-project"]')).toBeVisible();
  assert.equal(
    runtimes.get("friend").store.thread(runtimes.get("friend").thread.id).codexThreadId,
    runtimes.get("friend").nativeId,
  );
  await mkdir(".local/spaces-qa", { recursive: true });
  await page.screenshot({ path: ".local/spaces-qa/phone.png" });
  await other.screenshot({ path: ".local/spaces-qa/tablet.png" });
  assert.deepEqual(errors, []);
  console.log(
    "WebKit phone/tablet: space membership, project access, native continuity, shared tabs, 85x80 key geometry, human chat text/links/PNG/files, live reply/unread, popup draft and theme/keyboard geometry passed.",
  );
} catch (error) {
  await mkdir(".local/spaces-qa", { recursive: true });
  await page.screenshot({ path: ".local/spaces-qa/failure.png" });
  console.log(
    await page
      .locator(".space-dialog")
      .innerText()
      .catch(() => "no owner modal"),
  );
  throw error;
} finally {
  await browser.close();
  await hub.app.close();
  await rm(root, { recursive: true, force: true });
}
