import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, expect, webkit } from "@playwright/test";
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
const githubCalls = [],
  receipts = new Map();
let invitationAccepted = false;
async function githubProbe(machine, path, req) {
  const owner = path.endsWith("/owner") || path.endsWith("/owner-extra");
  const identity = { id: owner ? 11 : 22, login: owner ? "Owner" : "Friend" };
  githubCalls.push({ owner, ...req });
  const snapshot = {
    repository: req.repository,
    repositoryId: 100,
    identity,
    access: owner ? "admin" : "read",
    issues: true,
    checkedAt: Date.now(),
  };
  if (req.op === "observe")
    return {
      ...snapshot,
      query: req.query,
      collaborators: [
        {
          login: "Friend",
          state: invitationAccepted ? "accepted" : "pending",
          permission: "write",
        },
      ],
      nextPage: null,
    };
  if (req.op === "status") return receipts.get(req.id) || null;
  if (req.op === "prepare") {
    if (!receipts.has(req.id))
      receipts.set(req.id, {
        id: req.id,
        input: req.input,
        state: "prepared",
        snapshot,
        fingerprint: "a".repeat(64),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    return receipts.get(req.id);
  }
  const r = receipts.get(req.id);
  if (r.input.kind === "accept-invitation") invitationAccepted = true;
  r.state = "completed";
  r.result = { state: r.input.kind === "invite" ? "pending" : "accepted" };
  return r;
}
const hub = await createTeamHub(config, {
  githubProbe,
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
    personalStore.createThread(who + "-extra", randomUUID(), "Personal " + who + " chat");
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
const browser = await (process.env.BROWSER === "chromium" ? chromium : webkit).launch();
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
  if (await p.locator('.project-sheet[open][data-closing="true"]').count())
    await expect(p.locator('.project-sheet[open][data-closing="true"]')).toHaveCount(0);
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
async function request(p, path, body) {
  return p.evaluate(
    async ({ path, body }) => {
      const session = await (await fetch("/api/auth/session")).json();
      const r = await fetch("/api" + path, {
        method: body ? "POST" : "GET",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": session.csrf,
          "Idempotency-Key": crypto.randomUUID(),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const value = await r.json();
      if (!r.ok) throw Error(JSON.stringify(value));
      return value;
    },
    { path, body },
  );
}
try {
  await login(page, "owner");
  await login(other, "friend");
  await drawer(page);
  await drawer(other);
  errors.length = 0;
  const { id } = await request(page, "/team/spaces", {
    title: "Очень длинное название общего пространства Altar и World",
    kind: "space",
    userId: friend.id,
    personalProjectId: "owner-project",
    access: "collaborate",
    requestedAccess: "collaborate",
  });
  await page.evaluate(() => globalThis.dispatchEvent(new Event("focus")));
  const ownerNav = await drawer(page);
  await ownerNav.getByRole("button", { name: "Общие пространства", exact: true }).click();
  await ownerNav.locator(".space-entry").filter({ hasText: "Очень длинное" }).click();
  await ownerNav.getByRole("button", { name: "Настройки пространства", exact: true }).click();
  const settings = page.locator(".space-dialog");
  await settings.locator(".space-project-card summary").filter({ hasText: "Altar" }).click();
  const picker = settings.getByLabel("Доступ: Altar · Друг", { exact: true });
  await expect(picker).toHaveValue("collaborate");
  await picker.selectOption("direct");
  await expect(settings.getByRole("region", { name: "Доступ GitHub" })).toContainText(
    "Участник подключает GitHub",
  );
  await expect(picker).toHaveValue("direct");
  await page.keyboard.press("Escape");
  await other.evaluate(() => globalThis.dispatchEvent(new Event("focus")));
  const fn = await drawer(other);
  await fn.getByRole("button", { name: "Уведомления: 1", exact: true }).click();
  await other
    .locator(".space-dialog")
    .getByRole("button", { name: /Очень длинное/ })
    .click();
  const d = other.locator(".space-dialog");
  await d.getByRole("button", { name: "Далее", exact: true }).click();
  const panel = d.getByRole("region", { name: "Доступ GitHub" });
  await panel.getByLabel("Проект для аккаунта GitHub").selectOption("friend-project");
  await panel.getByRole("button", { name: "Проверить аккаунт", exact: true }).click();
  await expect(panel).toContainText("@Friend");
  assert.equal(githubCalls.filter((c) => c.op === "apply").length, 0);
  await panel.getByRole("button", { name: "Подключить аккаунт", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Принять Write", exact: true })).toBeVisible();
  assert.equal(githubCalls.filter((c) => c.op === "apply").length, 1);
  assert(githubCalls.filter((c) => c.op === "apply")[0].owner);
  await mkdir(".local/space-github-qa", { recursive: true });
  for (const size of [
    { width: 390, height: 844 },
    { width: 390, height: 430 },
    { width: 768, height: 1024 },
    { width: 1366, height: 1024 },
  ]) {
    await other.setViewportSize(size);
    for (const theme of ["organizer", "crt-green", "hitech-2000s", "classic-dark"]) {
      await other.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
      await panel
        .getByRole("button", { name: "Принять Write", exact: true })
        .scrollIntoViewIfNeeded();
      const geometry = await d.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return {
          left: r.left,
          right: r.right,
          top: r.top,
          bottom: r.bottom,
          width: innerWidth,
          height: innerHeight,
          overflow: el.scrollWidth > el.clientWidth + 1,
        };
      });
      assert(
        geometry.left >= 0 &&
          geometry.right <= size.width &&
          geometry.top >= 0 &&
          geometry.bottom <= size.height + 1 &&
          !geometry.overflow,
        JSON.stringify(geometry),
      );
      const buttons = await panel
        .locator(".space-actions")
        .last()
        .locator("button")
        .evaluateAll((nodes) =>
          nodes.map((n) => {
            const r = n.getBoundingClientRect();
            return { w: r.width, h: r.height, y: r.y };
          }),
        );
      assert.equal(buttons.length, 2);
      assert(Math.abs(buttons[0].w - buttons[1].w) < 1);
      assert(Math.abs(buttons[0].y - buttons[1].y) < 1);
      assert(buttons.every((b) => b.h >= 44));
      await other.screenshot({
        path: `.local/space-github-qa/${process.env.BROWSER || "webkit"}-${size.width}-${size.height}-${theme}.png`,
      });
    }
  }
  await panel.getByRole("button", { name: "Принять Write", exact: true }).click();
  await expect(panel).toContainText("GitHub Write предоставлен");
  assert.equal(githubCalls.filter((c) => c.op === "apply").length, 2);
  assert(!githubCalls.filter((c) => c.op === "apply")[1].owner);
  await d.getByLabel("Мой проект", { exact: true }).selectOption("friend-project");
  await d.getByRole("button", { name: "Далее", exact: true }).click();
  await d.getByRole("button", { name: "Далее", exact: true }).click();
  await d.getByRole("button", { name: "Присоединиться", exact: true }).click();
  await expect(d).toHaveCount(0);
  const result = await request(other, `/team/spaces/${id}/github-access`);
  assert.equal(result.grants[0].state, "accepted");
  const denied = await request(other, `/team/spaces/${id}/github-access`, {
    projectId: result.grants[0].projectId,
    userId: friend.id,
  });
  assert.equal(denied.grants[0].state, "accepted");
  assert.equal(githubCalls.filter((c) => c.op === "apply").length, 2);
  assert.deepEqual(errors, []);
  console.log(
    `${process.env.BROWSER || "webkit"}: verified account, automatic owner Write, internal recipient acceptance, no duplicate mutation and four-theme phone/keyboard/tablet geometry passed.`,
  );
} catch (error) {
  await mkdir(".local/space-github-qa", { recursive: true });
  await other.screenshot({ path: ".local/space-github-qa/failure.png" });
  console.log(
    await other
      .locator(".space-dialog")
      .innerText()
      .catch(() => ""),
  );
  throw error;
} finally {
  await browser.close();
  await hub.app.close();
  await rm(root, { recursive: true, force: true });
}
