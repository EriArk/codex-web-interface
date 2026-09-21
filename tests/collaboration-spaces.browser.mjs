import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
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
    const nativeCalls = [];
    const rpc = Object.assign(new EventEmitter(), {
      closed: false,
      initialize: async () => ({}),
      close() {
        this.closed = true;
      },
      async request(method, params) {
        nativeCalls.push({ method, params });
        if (method === "thread/start") return { thread: { id: randomUUID() } };
        if (method === "turn/start") return { turn: { id: randomUUID(), status: "inProgress" } };
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
    runtimes.set(who, { ...runtime, thread, nativeId, nativeCalls });
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
  if (p.viewportSize().width < 1100 && !(await p.locator(".project-sheet[open]").count()))
    await p.getByRole("button", { name: "Открыть проекты", exact: true }).click();
  if (p.viewportSize().width < 1100) await expect(p.locator(".project-sheet[open]")).toBeVisible();
  return p.locator(".navigation-inner:visible").last();
}
async function openSpaceChat(p) {
  if (await p.locator(".project-sheet[open]").count()) await p.keyboard.press("Escape");
  await expect(p.locator(".navigation-inner .space-chat-shortcut")).toHaveCount(0);
  await p
    .locator(".workspace-header")
    .getByRole("button", { name: /^Чат: Altar/ })
    .click();
  await expect(p.locator("dialog.space-chat-dialog[open]")).toBeVisible();
}
try {
  await login(page, "owner");
  await login(other, "friend");
  await page.bringToFront();
  const nav = await drawer(page);
  assert.equal(
    await nav.locator(".navigation-header > button").first().getAttribute("class"),
    "icon-button client-picker space-mode-toggle",
  );
  await expect(nav.locator(".workspace-shortcuts .space-bell")).toHaveText("Уведомления");
  await expect(nav.locator(".navigation-header .space-bell")).toHaveCount(0);
  await nav.getByRole("button", { name: "Общие пространства", exact: true }).click();
  await expect(page.locator(".space-home")).toContainText("Выберите пространство и проект");
  await expect(page.locator(".workspace-content")).toBeHidden();
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
  await dialog.getByText("Настройка Codex для совместной работы", { exact: true }).click();
  await dialog
    .getByLabel("Проверять влияние изменений на связанные проекты", { exact: true })
    .check();
  await dialog.getByLabel("Запускать подходящие тесты и сборку", { exact: true }).check();
  await dialog.getByLabel("Свои правила проекта", { exact: true }).fill("Совместимость API World");
  await dialog.getByRole("button", { name: "Пригласить", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(nav.locator(".space-selected")).toContainText("Altar + World");
  await nav.getByRole("button", { name: "Общие", exact: true }).click();
  await mkdir(".local/spaces-qa", { recursive: true });
  for (const width of [390, 1024]) {
    await page.setViewportSize({ width, height: 844 });
    for (const theme of ["organizer", "crt-green", "hitech-2000s", "classic-dark"]) {
      await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
      const entry = nav.locator(".space-entry");
      await expect(entry).toBeVisible();
      const geometry = await entry.evaluate((el) => {
        const icon = el.children[0].getBoundingClientRect(),
          text = el.children[1].getBoundingClientRect();
        return {
          direction: getComputedStyle(el).flexDirection,
          align: getComputedStyle(el).textAlign,
          iconLeft: icon.left,
          textLeft: text.left,
        };
      });
      assert.equal(geometry.direction, "row");
      assert.equal(geometry.align, "left");
      assert.ok(geometry.textLeft > geometry.iconLeft);
      await expect(entry.locator(".space-entry-details svg")).toHaveCount(2);
      await page.screenshot({ path: `.local/spaces-qa/space-row-${width}-${theme}.png` });
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => (document.documentElement.dataset.theme = "organizer"));
  await nav.locator(".space-entry").click();
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
  await dialog.getByLabel("Запускать подходящие тесты и сборку", { exact: true }).uncheck();
  await dialog.getByLabel("Свои правила проекта", { exact: true }).fill("Совместимость World v2");
  await dialog.getByRole("button", { name: "Применить и присоединиться", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  assert.deepEqual(runtimes.get("friend").projectGpts.get("friend-project").rules, {
    enabled: ["related"],
    custom: "Совместимость World v2",
  });
  assert.match(await readFile(join(root, "friend", "CODEXWEB.md"), "utf8"), /World v2/);
  assert.equal(
    execFileSync("git", ["-C", join(root, "friend"), "check-ignore", "CODEXWEB.md"], {
      encoding: "utf8",
    }).trim(),
    "CODEXWEB.md",
  );
  await expect(otherNav.locator('[data-project-id="friend-project"]')).toBeVisible();
  await otherNav.locator('[data-project-id="friend-project"]').click();
  await expect(other.locator(".space-home")).toHaveCount(0);
  await expect(other.locator(".workspace-content")).toBeVisible();
  await expect(other.locator(".project-sheet[open]")).toHaveCount(0);
  assert.equal(
    runtimes.get("friend").store.thread(runtimes.get("friend").thread.id).codexThreadId,
    runtimes.get("friend").nativeId,
  );
  await drawer(other);
  await otherNav.getByRole("button", { name: "Личные проекты", exact: true }).click();
  await expect(other.locator(".workspace-content")).toBeVisible();
  await otherNav.getByRole("button", { name: "Общие пространства", exact: true }).click();
  await expect(other.locator(".space-home")).toContainText("Выберите проект");
  await expect(other.locator(".workspace-content")).toBeHidden();
  await otherNav.locator('[data-project-id="friend-project"]').click();
  await expect(other.locator(".space-home")).toHaveCount(0);
  await expect(other.locator(".project-sheet[open]")).toHaveCount(0);
  await drawer(other);
  await otherNav.getByRole("button", { name: /Altar.*Совместная работа/ }).click();
  const sharedProject = other.locator(".space-dialog");
  await expect(
    sharedProject.getByRole("link", { name: "https://github.com/example/altar" }),
  ).toBeVisible();
  await sharedProject.getByRole("button", { name: "Создать рабочую копию", exact: true }).click();
  await expect(other.locator(".project-setup-dialog[open]")).toBeVisible();
  await other.keyboard.press("Escape");
  await sharedProject.getByLabel(/^Моя рабочая копия/).selectOption("friend-extra");
  await sharedProject
    .getByRole("button", { name: "Подключить и открыть Codex", exact: true })
    .click();
  await expect(sharedProject).toHaveCount(0);
  await expect(other.locator(".project-sheet[open]")).toHaveCount(0);
  await expect(other.locator(".space-home")).toHaveCount(0);
  await expect(other.locator(".workspace-content")).toBeVisible();
  const introCalls = runtimes.get("friend").nativeCalls.filter((c) => c.method === "turn/start");
  assert.equal(introCalls.length, 1);
  assert.ok(JSON.stringify(introCalls[0].params).includes("https://github.com/example/altar"));
  const catalog = await (await other.request.get(base + "/api/team/spaces")).json();
  const linked = catalog.spaces[0].projects.find((p) => p.personalProjectId === "friend-extra");
  const introUrl = base + `/api/team/spaces/${catalog.spaces[0].id}/projects/${linked.id}/chat`;
  const csrf = (
    await (
      await other.request.get(base + "/api/auth/session", {
        headers: { origin: base },
      })
    ).json()
  ).csrf;
  const again = await other.request.post(introUrl, {
    headers: { origin: base, "x-csrf-token": csrf, "idempotency-key": randomUUID() },
    data: {},
  });
  assert.equal(again.status(), 200);
  assert.equal(
    runtimes.get("friend").nativeCalls.filter((c) => c.method === "turn/start").length,
    1,
  );
  await drawer(other);
  await otherNav
    .getByRole("button", { name: /Altar.*Совместная работа/ })
    .first()
    .click();
  await expect(
    other.getByRole("dialog", { name: "Обзор проекта Altar copy", exact: true }),
  ).toBeVisible();
  await other.keyboard.press("Escape");
  await expect(
    other.getByRole("dialog", { name: "Обзор проекта Altar copy", exact: true }),
  ).toHaveCount(0);
  await drawer(other);
  await otherNav.getByRole("button", { name: "Настройки пространства", exact: true }).click();
  const settings = other.locator(".space-dialog");
  await settings.locator("summary").filter({ hasText: "Altar" }).click();
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
  // A third member joins an existing space. Foreign grants are chosen by that project's owner.
  const third = hub.registry.accept(
    hub.registry.invite(hub.registry.ownerId, "Третий").token,
    "third",
    "Третий",
    await teamPasswordHash(password),
    10,
  );
  hub.registry.db
    .prepare("INSERT INTO team_meta(key,value) VALUES(?,?)")
    .run(`onboarding:${third.id}`, "deferred");
  const thirdContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    serviceWorkers: "block",
  });
  const thirdPage = await thirdContext.newPage();
  thirdPage.on("pageerror", (e) => errors.push(e.message));
  await login(thirdPage, "third");
  await ownerSettings.getByRole("button", { name: "Пригласить участника", exact: true }).click();
  await ownerSettings
    .getByRole("group", { name: "Пользователи Hub", exact: true })
    .getByRole("button", { name: /Третий/ })
    .click();
  await ownerSettings.getByLabel("Приглашение: Altar", { exact: true }).selectOption("collaborate");
  await ownerSettings.getByText("Рекомендации Codex", { exact: true }).click();
  const inviteForm = ownerSettings.getByRole("form", { name: "Приглашение участника" });
  await inviteForm.getByLabel("Не делать несвязанный рефакторинг", { exact: true }).check();
  // Focused theme/keyboard geometry on the changed invitation form.
  for (const width of [390, 768, 1024, 1366]) {
    await page.setViewportSize({ width, height: 400 });
    for (const theme of ["organizer", "crt-green", "hitech-2000s", "classic-dark"]) {
      await page.evaluate((t) => {
        document.documentElement.dataset.theme = t;
        document.documentElement.dataset.keyboard = "true";
        document.documentElement.style.setProperty("--app-height", "400px");
      }, theme);
      await inviteForm
        .getByRole("button", { name: "Пригласить", exact: true })
        .scrollIntoViewIfNeeded();
      const bounds = await ownerSettings.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const b = el
          .querySelector('form[aria-label="Приглашение участника"] button[type="submit"]')
          .getBoundingClientRect();
        return {
          top: r.top,
          bottom: r.bottom,
          buttonBottom: b.bottom,
          overflow: el.scrollWidth > el.clientWidth + 1,
        };
      });
      assert.ok(
        bounds.top >= 0 && bounds.bottom <= 401 && bounds.buttonBottom <= 401 && !bounds.overflow,
        JSON.stringify({ width, theme, bounds }),
      );
    }
  }
  await page.evaluate(() => {
    delete document.documentElement.dataset.keyboard;
    document.documentElement.style.setProperty("--app-height", "844px");
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: ".local/spaces-qa/additional-invite-phone.png" });
  await inviteForm.getByRole("button", { name: "Пригласить", exact: true }).click();
  await expect(inviteForm).toHaveCount(0);
  await other.evaluate(() => globalThis.dispatchEvent(new Event("focus")));
  await settings
    .locator("summary")
    .filter({ hasText: /^World/ })
    .click();
  await settings.getByLabel("Доступ: World · Третий", { exact: true }).selectOption("direct");
  await expect(settings.getByLabel("Доступ: World · Третий", { exact: true })).toHaveValue(
    "direct",
  );
  await thirdPage.reload();
  const thirdNav = await drawer(thirdPage);
  await thirdNav.getByRole("button", { name: "Уведомления: 1", exact: true }).click();
  const thirdDialog = thirdPage.locator(".space-dialog");
  await thirdDialog.getByRole("button", { name: /Altar \+ World/ }).click();
  await thirdDialog.getByRole("button", { name: "Далее", exact: true }).click();
  await thirdDialog.getByLabel("Мой проект", { exact: true }).selectOption("third-project");
  await thirdDialog.getByRole("button", { name: "Далее", exact: true }).click();
  await thirdDialog
    .getByLabel("Доступ для Друг к моему проекту", { exact: true })
    .selectOption("direct");
  await thirdDialog.getByRole("button", { name: "Далее", exact: true }).click();
  await thirdDialog.getByLabel("Не делать несвязанный рефакторинг", { exact: true }).uncheck();
  await thirdDialog
    .getByRole("button", { name: "Применить и присоединиться", exact: true })
    .click();
  await expect(thirdDialog).toHaveCount(0);
  await assert.rejects(readFile(join(root, "third", "CODEXWEB.md")));
  await thirdNav.getByRole("button", { name: "Настройки пространства", exact: true }).click();
  await thirdDialog
    .locator("summary")
    .filter({ hasText: /^World/ })
    .last()
    .click();
  await thirdDialog.getByText("Мои настройки Codex", { exact: true }).click();
  await thirdDialog.getByLabel("Не делать несвязанный рефакторинг", { exact: true }).check();
  await thirdDialog.getByRole("button", { name: "Применить правила", exact: true }).click();
  await expect
    .poll(() => runtimes.get("third").projectGpts.get("third-project").rules.enabled)
    .toEqual(["focused"]);
  await thirdDialog.getByRole("button", { name: "Выйти из пространства", exact: true }).click();
  await thirdDialog.getByRole("button", { name: "Выйти", exact: true }).click();
  await expect(thirdDialog).toHaveCount(0);
  await thirdContext.close();
  // Human chat is a separate popup: files, live replies, exact-send retry and unread badges.
  await ownerSettings.getByLabel("Закрыть пространство", { exact: true }).click();
  await settings.getByLabel("Закрыть пространство", { exact: true }).click();
  await nav.getByRole("button", { name: "Общие пространства", exact: true }).click();
  await expect(nav.locator(".nav-mobile-switch > button").nth(0)).toHaveText("Пространства");
  await expect(nav.locator(".nav-mobile-switch > button").nth(1)).toHaveText("Брейншторм");
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
      const layout = await visibleNav.locator(".navigation-header").evaluate((el) => {
        const buttons = [...el.querySelector(".nav-mobile-switch").children],
          cap = el.querySelector(".space-mode-toggle").getBoundingClientRect();
        const left = buttons[0].querySelector(".nav-tab-title").getBoundingClientRect();
        const right = buttons[1].querySelector(".nav-tab-title").getBoundingClientRect();
        return {
          width: cap.width,
          height: cap.height,
          overlap: left.left < cap.right || right.left < left.right,
          overflows: el.scrollWidth > el.clientWidth + 1,
          left: left.right,
          right: right.left,
          capLeft: cap.left,
          capRight: cap.right,
        };
      });
      assert.equal(layout.width, 58);
      assert.equal(layout.height, 58);
      assert.ok(!layout.overlap && !layout.overflows, JSON.stringify({ width, theme, layout }));
      if (width === 390 || width === 1024)
        await page.screenshot({ path: `.local/spaces-qa/navigation-${width}-${theme}.png` });
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await drawer(page);
  await openSpaceChat(page);
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
  await openSpaceChat(other);
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
  await openSpaceChat(page);
  await expect(chat.getByLabel("Сообщение участникам")).toHaveValue("Черновик общего чата");
  await chat.getByLabel("Закрыть пространство", { exact: true }).click();
  await otherChat.getByLabel("Закрыть пространство", { exact: true }).click();
  for (const width of [390, 768, 1024, 1366]) {
    await page.setViewportSize({ width, height: 844 });
    for (const theme of ["organizer", "crt-green", "hitech-2000s", "classic-dark"]) {
      await page.evaluate((t) => {
        document.documentElement.dataset.theme = t;
      }, theme);
      const header = page.locator(".workspace-header");
      const geometry = await header.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const buttons = [...el.querySelectorAll(":scope > button")]
          .map((b) => b.getBoundingClientRect())
          .filter((b) => b.width > 0);
        return {
          overflow: el.scrollWidth > el.clientWidth + 1,
          outside: buttons.some((b) => b.left < r.left || b.right > r.right + 1),
          overlap: buttons.some((b, i) => i > 0 && b.left < buttons[i - 1].right - 1),
        };
      });
      assert.ok(
        !geometry.overflow && !geometry.outside && !geometry.overlap,
        JSON.stringify({ width, theme, geometry }),
      );
      await expect(header.locator(".header-space-chat")).toBeVisible();
      if (width === 390 || width === 1024)
        await page.screenshot({ path: `.local/spaces-qa/header-chat-${width}-${theme}.png` });
    }
  }
  await drawer(other);
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
  await page.setViewportSize({ width: 1366, height: 1024 });
  const divider = page.getByRole("separator", { name: "Ширина левой панели", exact: true });
  await expect(divider).toBeVisible();
  const navWidth = () =>
    page.locator(".desktop-nav").evaluate((el) => el.getBoundingClientRect().width);
  const beforeWidth = await navWidth(),
    grip = await divider.boundingBox();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2 + 50, grip.y + grip.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect.poll(navWidth).toBeGreaterThan(beforeWidth + 35);
  await divider.focus();
  await page.keyboard.press("Home");
  await expect.poll(navWidth).toBe(260);
  await page.keyboard.press("ArrowRight");
  await expect.poll(navWidth).toBe(276);
  await page.reload();
  await expect.poll(navWidth).toBe(276);
  await page.getByRole("button", { name: "Скрыть правую панель", exact: true }).click();
  await expect(divider).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(divider).toBeHidden();
  console.log(
    "WebKit phone/tablet: space membership, project access, native continuity, shared tabs, left 58x58 round key geometry, human chat text/links/PNG/files, live reply/unread, popup draft and theme/keyboard geometry passed.",
  );
} catch (error) {
  await mkdir(".local/spaces-qa", { recursive: true });
  await page.screenshot({ path: ".local/spaces-qa/failure.png" });
  await other.screenshot({ path: ".local/spaces-qa/failure-friend.png" });
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
