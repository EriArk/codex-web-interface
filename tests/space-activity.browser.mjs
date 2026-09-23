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
import { CollaborationSpaces } from "../apps/hub/dist/collaboration-spaces.js";
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
let activityCalls = 0;
async function activityProbe(_machine, _root, request) {
  activityCalls++;
  return {
    repository: request.repository,
    repositoryId: 42,
    identity: { id: 1, login: "Owner" },
    access: "read",
    checkedAt: Date.now(),
    query: request.query,
    activity: Array.from({ length: 27 }, (_, i) => ({
      kind: i < 3 ? "commit" : i % 2 ? "pr" : "issue",
      key: i < 3 ? "commit:" + String(i + 1).repeat(40) : `${i % 2 ? "pr" : "issue"}:${i}`,
      sha: String(i + 1)
        .slice(0, 1)
        .repeat(40),
      number: i,
      title:
        i < 3
          ? [
              "Add location lookup API",
              "Preserve nullable fields in old saves",
              "Test shared world contracts",
            ][i]
          : "Совместимость проекта и синхронизация данных между приложениями — проверка изменений " +
            i,
      at: new Date(Date.UTC(2026, 8, 23, 12, -i * 5)).toISOString(),
      state: i === 3 ? "merged" : "open",
      author: { id: i < 3 ? 1 : 2, login: i < 3 ? "Lev" : "Lazar" },
      authorName: "fixture",
      url: `https://github.com/${request.repository}/${i < 3 ? "commit/" + String(i + 1).repeat(40) : i % 2 ? "pull/" + i : "issues/" + i}`,
    })),
  };
}
const hub = await createTeamHub(config, {
  store,
  githubProbe: activityProbe,
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
try {
  const spaces = new CollaborationSpaces(hub.teamProjects);
  const created = spaces.create(
    hub.registry.ownerId,
    randomUUID(),
    {
      title: "Altar + World",
      kind: "project",
      userId: friend.id,
      personalProjectId: "owner-project",
      access: "collaborate",
      requestedAccess: "collaborate",
    },
    {
      personalProjectId: "owner-project",
      name: "Altar",
      repository: "https://github.com/example/altar",
    },
  );
  spaces.answer(
    friend.id,
    created.id,
    randomUUID(),
    { revision: 1, accept: true, access: "collaborate" },
    {
      personalProjectId: "friend-extra",
      name: "Altar copy",
      repository: "https://github.com/example/altar",
    },
  );
  await login(page, "owner");
  const nav = await drawer(page);
  await nav.getByRole("button", { name: "Общие пространства", exact: true }).click();
  await nav.locator(".space-entry").click();
  await nav.getByRole("button", { name: "Активность", exact: true }).click();
  const dialog = page.locator("dialog.activity-dialog[open]");
  await expect(
    dialog.getByRole("heading", { name: "Add location lookup API", exact: true }),
  ).toBeVisible();
  await expect(dialog.locator(".activity-card")).toHaveCount(20);
  await expect(dialog.getByText("Все коммиты · 3", { exact: true })).toBeVisible();
  const reads = activityCalls;
  await dialog.getByLabel("Автор активности").selectOption("1");
  await expect(dialog.locator(".activity-card")).toHaveCount(1);
  await dialog.getByText("Все коммиты · 3", { exact: true }).click();
  await expect(dialog.locator("details li")).toHaveCount(3);
  await dialog.getByLabel("Автор активности").selectOption("2");
  await expect(dialog.locator(".activity-card")).toHaveCount(20);
  await dialog.getByLabel("Автор активности").selectOption("");
  assert.equal(activityCalls, reads, "filters must not read native GitHub");
  await dialog.getByRole("button", { name: "Показать ещё", exact: true }).click();
  await expect(dialog.locator(".activity-card")).toHaveCount(25);
  const sourceRoute = "https://github.com/**";
  await ownerContext.route(sourceRoute, (route) => route.fulfill({ body: "Exact GitHub source" }));
  await dialog.getByText("Все коммиты · 3", { exact: true }).click();
  const popupEvent = page.waitForEvent("popup");
  await dialog.locator("details li button").first().click();
  const popup = await popupEvent;
  await expect(popup).toHaveURL("https://github.com/example/altar/commit/" + "1".repeat(40));
  await popup.close();
  assert.equal(activityCalls, reads + 1, "opening rechecks access");
  await mkdir(".local/activity-qa", { recursive: true });
  for (const viewport of [
    { width: 390, height: 500 },
    { width: 1024, height: 768 },
    { width: 1366, height: 1024 },
  ]) {
    await page.setViewportSize(viewport);
    for (const theme of ["organizer", "crt-green", "hitech-2000s", "classic-dark"]) {
      await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
      await expect
        .poll(() =>
          dialog.evaluate((el) => {
            const r = el.getBoundingClientRect();
            return (
              r.left >= 0 &&
              r.right <= innerWidth + 1 &&
              r.top >= 0 &&
              r.bottom <= innerHeight + 1 &&
              el.scrollWidth <= el.clientWidth + 1
            );
          }),
        )
        .toBe(true);
      await expect(dialog.getByRole("button", { name: "Закрыть пространство" })).toBeInViewport();
      await expect(dialog.getByLabel("Проект активности")).toBeInViewport();
      assert(
        await dialog
          .locator(".activity-feed")
          .evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
      );
      await page.screenshot({
        path: `.local/activity-qa/${process.env.BROWSER || "webkit"}-${theme}-${viewport.width}.png`,
      });
    }
  }
  await dialog.getByRole("button", { name: "Закрыть пространство" }).click();
  await expect(dialog).toHaveCount(0);
  assert.equal(errors.length, 0, errors.join("\n"));
  console.log(
    "Activity grouping, local filters, pagination, exact authorized source and four-theme phone/keyboard/tablet/desktop geometry passed.",
  );
} finally {
  await browser.close();
  await hub.app.close();
  await rm(root, { recursive: true, force: true });
}
