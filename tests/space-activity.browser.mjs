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
import { issueWorkflow } from "./fixtures/issue-workflow-browser.mjs";
import { nativeWorkspaceFixture } from "./fixtures/native-workspace.mjs";
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
const native = nativeWorkspaceFixture();
const friendNative = nativeWorkspaceFixture();
let friendSentAt = 0;
const friendDispatch = friendNative.client.dispatchText,
  friendGraph = friendNative.client.conversationGraph;
friendNative.client.dispatchText = async (input) => {
  friendSentAt = Math.floor(Date.now() / 1000);
  return friendDispatch(input);
};
friendNative.client.conversationGraph = async (id) => {
  const value = await friendGraph(id);
  for (const node of Object.values(value.mapping))
    if (node.message && node.message.create_time === 100 && friendSentAt)
      node.message.create_time = friendSentAt;
  return value;
};
let activityCalls = 0;
let changedActivity = false,
  blockedActivity = false;
async function activityProbe(_machine, _root, request) {
  activityCalls++;
  return {
    repository: request.repository,
    repositoryId: 42,
    identity: { id: 1, login: "Owner" },
    access: blockedActivity ? "unavailable" : "read",
    checkedAt: Date.now(),
    query: request.query,
    commit:
      request.query.kind === "evidence" && request.query.source.startsWith("commit:")
        ? {
            sha: request.query.source.slice(7),
            message: "Exact commit description",
            parents: [],
            truncated: false,
            files: [
              {
                path: "src/example.ts",
                status: "modified",
                additions: 1,
                deletions: 0,
                patch: "+ nullable field",
                patchOmitted: false,
              },
            ],
          }
        : undefined,
    record:
      request.query.kind === "detail"
        ? {
            type: request.query.type,
            number: request.query.number,
            title: "Exact embedded GitHub record",
            body: "Native issue description",
            author: { id: 1, login: "Owner" },
            state: "open",
            url: `https://github.com/${request.repository}/issues/${request.query.number}`,
            updatedAt: new Date().toISOString(),
            createdAt: new Date().toISOString(),
            comments: 1,
            assignees: [],
            labels: [],
            truncated: false,
          }
        : undefined,
    commentsPage:
      request.query.kind === "detail"
        ? [
            {
              id: 1,
              author: { id: 1, login: "Owner" },
              body: "Native GitHub comment",
              createdAt: new Date().toISOString(),
              url: "https://github.com/example/altar/issues/3#issuecomment-1",
            },
          ]
        : undefined,
    evidence:
      request.query.kind === "evidence"
        ? { source: request.query.source, text: "Exact patch + nullable field", truncated: false }
        : undefined,
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
          : (changedActivity && i === 3 ? "Обновлено: " : "") +
            "Совместимость проекта и синхронизация данных между приложениями — проверка изменений " +
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
    const runtime = await createApp(cfg, {
      ...options,
      sessions,
      store: personalStore,
      nativeGpt: who === "owner" ? native.workspace : friendNative.workspace,
    });
    runtimes.set(who, { ...runtime, thread, nativeId, nativeCalls, rpc });
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
  hub.teamProjects.db.prepare("DELETE FROM space_journal").run();
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
  let externalOpened = false;
  page.on("popup", () => {
    externalOpened = true;
  });
  if (
    !(await dialog
      .locator("details")
      .first()
      .evaluate((el) => el.open))
  )
    await dialog.getByText("Все коммиты · 3", { exact: true }).click();
  await dialog.locator("details li button").first().click();
  const sourceWindow = page.getByRole("dialog", { name: "GitHub · событие", exact: true });
  await expect(sourceWindow).toContainText("Exact commit description");
  await sourceWindow.getByText("src/example.ts", { exact: false }).click();
  await expect(sourceWindow.locator("pre")).toContainText("+ nullable field");
  await mkdir(".local/activity-continuity-qa", { recursive: true });
  for (const viewport of [
    { width: 390, height: 500 },
    { width: 1024, height: 768 },
  ]) {
    await page.setViewportSize(viewport);
    for (const theme of ["organizer", "crt-green", "hitech-2000s", "classic-dark"]) {
      await page.evaluate((v) => (document.documentElement.dataset.theme = v), theme);
      await expect(sourceWindow.getByRole("button", { name: "Закрыть событие" })).toBeInViewport();
      assert(await sourceWindow.evaluate((el) => el.scrollWidth <= el.clientWidth + 1));
      await page.screenshot({
        path: `.local/activity-continuity-qa/${process.env.BROWSER || "webkit"}-${theme}-${viewport.width}.png`,
      });
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await sourceWindow.getByRole("button", { name: "Закрыть событие" }).click();
  assert.equal(externalOpened, false, "source stays inside the app");
  assert.equal(activityCalls, reads + 2, "opening rechecks access and fetches exact commit");
  await dialog.getByRole("button", { name: "Открыть PR", exact: true }).first().click();
  await expect(sourceWindow).toContainText("Exact embedded GitHub record");
  await expect(sourceWindow).toContainText("Native GitHub comment");
  await sourceWindow.getByRole("button", { name: "Закрыть событие" }).click();
  const deltaReplies = [];
  let releaseRefresh;
  await page.route("**/api/team/spaces/*/activity", async (route) => {
    if (releaseRefresh !== undefined)
      await new Promise((resolve) => {
        releaseRefresh = resolve;
      });
    const response = await route.fetch();
    deltaReplies.push(await response.json());
    await route.fulfill({ response });
  });
  await dialog.getByLabel("Автор активности").selectOption("2");
  await dialog.getByRole("button", { name: "Показать ещё", exact: true }).click();
  await dialog.locator(".activity-feed").evaluate((el) => (el.scrollTop = 250));
  const previousScroll = await dialog.locator(".activity-feed").evaluate((el) => el.scrollTop);
  releaseRefresh = () => {};
  await dialog.getByRole("button", { name: "Обновить активность" }).click();
  await expect(dialog.locator(".activity-card")).toHaveCount(24);
  await expect(dialog.getByText("Загружаем события…")).toHaveCount(0);
  await expect.poll(() => releaseRefresh.toString().includes("native code")).toBe(true);
  const resume = releaseRefresh;
  releaseRefresh = undefined;
  resume();
  await expect(dialog.getByRole("button", { name: "Обновить активность" })).toBeEnabled();
  assert.equal(deltaReplies.at(-1).delta, true);
  assert.equal(deltaReplies.at(-1).items.length, 0);
  assert(
    Math.abs(
      (await dialog.locator(".activity-feed").evaluate((el) => el.scrollTop)) - previousScroll,
    ) < 2,
  );
  await dialog.getByRole("button", { name: "Закрыть пространство" }).click();
  const backNav = await drawer(page);
  releaseRefresh = () => {};
  await backNav.getByRole("button", { name: "Активность", exact: true }).click();
  await expect(dialog.locator(".activity-card")).toHaveCount(24);
  await expect(dialog.getByLabel("Автор активности")).toHaveValue("2");
  await expect
    .poll(async () =>
      Math.abs(
        (await dialog.locator(".activity-feed").evaluate((el) => el.scrollTop)) - previousScroll,
      ),
    )
    .toBeLessThan(2);
  await expect.poll(() => releaseRefresh.toString().includes("native code")).toBe(true);
  const resumeOpen = releaseRefresh;
  releaseRefresh = undefined;
  resumeOpen();
  await expect(dialog.getByRole("button", { name: "Обновить активность" })).toBeEnabled();
  changedActivity = true;
  for (const row of hub.teamProjects.db
    .prepare("SELECT userId,spaceId,projectId,data FROM space_activity_index")
    .all()) {
    const value = JSON.parse(row.data);
    value.checkedAt = 0;
    hub.teamProjects.db
      .prepare(
        "UPDATE space_activity_index SET data=? WHERE userId=? AND spaceId=? AND projectId=?",
      )
      .run(JSON.stringify(value), row.userId, row.spaceId, row.projectId);
  }
  await dialog.getByRole("button", { name: "Обновить активность" }).click();
  await expect(dialog.getByRole("button", { name: "Обновить активность" })).toBeEnabled();
  assert.equal(deltaReplies.at(-1).items.length, 1, "only changed source is transferred");
  await dialog.getByLabel("Автор активности").selectOption("");
  await dialog.locator(".activity-feed").evaluate((el) => (el.scrollTop = 0));
  // Real HTTP + durable receipts: a lost acknowledgement and reopening must not duplicate a reply.
  let lostReply = false;
  await page.route("**/api/team/spaces/*/activity/reply", async (route) => {
    if (!lostReply) {
      lostReply = true;
      await route.fetch();
      await route.abort("failed");
    } else await route.continue();
  });
  await dialog.getByRole("button", { name: "Нравится", exact: true }).first().click();
  await expect(
    dialog.getByRole("button", { name: "Нравится", exact: true }).first(),
  ).toHaveAttribute("aria-pressed", "true");
  const discussion = () => dialog.locator(".activity-discussion").first();
  await dialog.getByRole("button", { name: "Обсуждение", exact: true }).first().click();
  await discussion()
    .getByRole("textbox", { name: "Короткий ответ" })
    .fill("Проверь совместимость старых сохранений.");
  await discussion().getByLabel("Кому ответ").selectOption(friend.id);
  await discussion().getByRole("button", { name: "Отправить ответ", exact: true }).click();
  await expect(dialog.locator(".activity-social [role=status]").first()).toBeVisible();
  assert.equal(hub.teamProjects.db.prepare("SELECT count(*) n FROM activity_replies").get().n, 1);
  await dialog.getByRole("button", { name: "Закрыть пространство" }).click();
  const reopenedNav = await drawer(page);
  await reopenedNav.getByRole("button", { name: "Активность", exact: true }).click();
  await dialog.getByRole("button", { name: "Обсуждение · 1", exact: true }).first().click();
  await expect(discussion().getByRole("textbox", { name: "Короткий ответ" })).toHaveValue(
    "Проверь совместимость старых сохранений.",
  );
  await discussion().getByRole("button", { name: "Отправить ответ", exact: true }).click();
  await expect(discussion().getByRole("textbox", { name: "Короткий ответ" })).toHaveValue("");
  assert.equal(hub.teamProjects.db.prepare("SELECT count(*) n FROM activity_replies").get().n, 1);
  await dialog.getByLabel("Коммит для обсуждения").selectOption("commit:" + "2".repeat(40));
  await expect(
    dialog
      .locator(".activity-card")
      .first()
      .getByRole("button", { name: "Обсуждение", exact: true }),
  ).toBeVisible();
  await dialog.getByLabel("Коммит для обсуждения").selectOption("commit:" + "1".repeat(40));
  await dialog.getByRole("button", { name: "Обсуждение · 1", exact: true }).first().click();
  await login(other, "friend");
  const friendNav = await drawer(other);
  await friendNav.getByRole("button", { name: /^Уведомления/ }).click();
  await other.getByRole("button", { name: /обращается к тебе в обсуждении события/ }).click();
  const replyDialog = other.locator("dialog.activity-dialog[open]");
  await expect(replyDialog.locator(".activity-reply")).toContainText(
    "Проверь совместимость старых сохранений.",
  );
  await expect
    .poll(() => hub.teamProjects.db.prepare("SELECT count(*) n FROM activity_attention").get().n)
    .toBe(0);
  await replyDialog.getByRole("button", { name: "Ответить", exact: true }).click();
  await replyDialog.getByRole("textbox", { name: "Короткий ответ" }).fill("Проверил: совместимо.");
  await replyDialog.getByRole("button", { name: "Отправить ответ", exact: true }).click();
  await expect(replyDialog.getByRole("textbox", { name: "Короткий ответ" })).toHaveValue("");
  assert.equal(
    hub.teamProjects.db.prepare("SELECT userId FROM activity_attention").get().userId,
    hub.registry.ownerId,
  );
  await mkdir(".local/activity-social-qa", { recursive: true });
  for (const viewport of [
    { width: 390, height: 500 },
    { width: 1024, height: 768 },
  ]) {
    await other.setViewportSize(viewport);
    for (const theme of ["organizer", "crt-green", "hitech-2000s", "classic-dark"]) {
      await other.evaluate((v) => (document.documentElement.dataset.theme = v), theme);
      await replyDialog.getByRole("textbox", { name: "Короткий ответ" }).scrollIntoViewIfNeeded();
      await expect(
        replyDialog.getByRole("button", { name: "Закрыть пространство" }),
      ).toBeInViewport();
      assert(await replyDialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1));
      await other.screenshot({
        path: `.local/activity-social-qa/${process.env.BROWSER || "webkit"}-${theme}-${viewport.width}.png`,
      });
    }
  }
  await replyDialog.getByRole("button", { name: "Закрыть пространство" }).click();
  // Keep the original feed check below scoped to its collapsed initial presentation.
  await dialog.getByRole("button", { name: "Обсуждение · 1", exact: true }).first().click();
  // Existing personal GPT binding, including a saved draft, is reused.
  const ownerRuntime = runtimes.get("owner");
  await ownerRuntime.gpt.catalog();
  ownerRuntime.projectGpts.bind("owner-project", native.conversationId, 0);
  await dialog.getByRole("button", { name: "Обсудить в GPT", exact: true }).first().click();
  const gptWindow = page.locator(".project-gpt-window[open]");
  const composer = gptWindow.getByRole("textbox", { name: "Сообщение GPT", exact: true });
  await expect(composer).toBeVisible();
  await expect(gptWindow.getByText("Первый ответ", { exact: true })).toBeVisible();
  await expect(gptWindow.getByRole("group", { name: "Контекст Activity" })).toContainText(
    "Источников: 3",
  );
  assert.equal(native.state.sends, 0);
  await composer.fill("Does this affect old saves?");
  await gptWindow.getByRole("button", { name: "Закрыть GPT проекта", exact: true }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Обсудить в GPT", exact: true }).first().click();
  await expect(composer).toHaveValue("Does this affect old saves?");
  const pendingHandoff = await page.evaluate(
    () =>
      Object.entries(sessionStorage).find(([k]) =>
        k.endsWith("project-activity-handoff:owner-project"),
      )?.[1],
  );
  assert(pendingHandoff, "pending context survives close");
  await mkdir(".local/activity-gpt-qa", { recursive: true });
  for (const viewport of [
    { width: 390, height: 500 },
    { width: 1024, height: 768 },
  ]) {
    await page.setViewportSize(viewport);
    for (const theme of ["organizer", "crt-green", "hitech-2000s", "classic-dark"]) {
      await page.evaluate((v) => (document.documentElement.dataset.theme = v), theme);
      await expect(composer).toBeInViewport();
      await expect(gptWindow.getByRole("button", { name: "Закрыть GPT проекта" })).toBeInViewport();
      await expect(gptWindow.getByRole("group", { name: "Контекст Activity" })).toBeInViewport();
      await page.screenshot({
        path: `.local/activity-gpt-qa/${process.env.BROWSER || "webkit"}-${theme}-${viewport.width}.png`,
      });
    }
  }
  let dropped = false;
  await page.route("**/api/team/activity-handoffs/*/send", async (route) => {
    if (!dropped) {
      dropped = true;
      await route.fetch();
      await route.abort("failed");
    } else await route.continue();
  });
  await gptWindow.getByRole("button", { name: "Отправить GPT", exact: true }).click();
  await expect.poll(() => native.state.sends).toBe(1);
  assert.match(native.state.input.text, /Exact patch/);
  assert.match(native.state.input.text, /Does this affect old saves\?$/);
  assert.equal(
    native.state.input.conversationId ?? native.state.input.nativeId,
    native.conversationId,
  );
  await expect(composer).toHaveValue("Does this affect old saves?");
  await gptWindow.getByRole("button", { name: "Закрыть GPT проекта", exact: true }).click();
  await dialog.getByRole("button", { name: "Обсудить в GPT", exact: true }).first().click();
  await expect(composer).toHaveValue("Does this affect old saves?");
  assert.equal(
    await page.evaluate(
      () =>
        Object.entries(sessionStorage).find(([k]) =>
          k.endsWith("project-activity-handoff:owner-project"),
        )?.[1],
    ),
    pendingHandoff,
  );
  await gptWindow.getByRole("button", { name: /Отправить GPT|Добавить в очередь GPT/ }).click();
  await expect(gptWindow.getByRole("group", { name: "Контекст Activity" })).toHaveCount(0);
  assert.equal(native.state.sends, 1, "lost acknowledgment retry must not send twice");
  native.state.finished = true;
  await gptWindow.getByRole("button", { name: "Закрыть GPT проекта", exact: true }).click();
  await issueWorkflow({
    browser,
    other,
    login,
    drawer,
    runtimes,
    friendNative,
    spaces,
    spaceId: created.id,
    ownerId: hub.registry.ownerId,
    activityProbe,
    base,
  });
  await mkdir(".local/activity-qa", { recursive: true });
  for (const viewport of [
    { width: 390, height: 500 },
    { width: 1024, height: 768 },
    { width: 1366, height: 1024 },
    { width: 390, height: 844 },
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
      await dialog.locator(".activity-feed").evaluate((el) => {
        el.scrollTop = 0;
      });
      assert(
        await dialog
          .locator(".activity-primary-actions")
          .first()
          .evaluate((el) => {
            const buttons = [...el.querySelectorAll(":scope > button")]
              .slice(-2)
              .map((b) => b.getBoundingClientRect());
            return (
              buttons.length === 2 &&
              Math.abs(buttons[0].top - buttons[1].top) < 2 &&
              Math.abs(buttons[0].width - buttons[1].width) < 2 &&
              buttons.every((b) => b.height >= 44)
            );
          }),
        "assistant actions align in equal touch columns",
      );
      await page.screenshot({
        path: `.local/activity-social-qa/feed-${process.env.BROWSER || "webkit"}-${theme}-${viewport.width}.png`,
      });
      assert(
        await dialog
          .locator(".activity-feed")
          .evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
        JSON.stringify({
          theme,
          viewport,
          overflow: await dialog.locator(".activity-feed").evaluate((el) =>
            [el, ...el.querySelectorAll("*")]
              .filter((n) => n.scrollWidth > n.clientWidth + 1)
              .map((n) => ({
                tag: n.tagName,
                class: n.className,
                width: n.getBoundingClientRect().width,
                client: n.clientWidth,
                scroll: n.scrollWidth,
              }))
              .slice(0, 15),
          ),
        }),
      );
      await page.screenshot({
        path: `.local/activity-qa/${process.env.BROWSER || "webkit"}-${theme}-${viewport.width}.png`,
      });
    }
  }
  blockedActivity = true;
  await dialog.getByRole("button", { name: "Обновить активность" }).click();
  await expect(dialog.getByRole("button", { name: "Обновить активность" })).toBeEnabled();
  await expect(dialog.locator(".activity-card")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Закрыть пространство" }).click();
  const deniedNav = await drawer(page);
  await deniedNav.getByRole("button", { name: "Активность", exact: true }).click();
  await expect(dialog.locator(".activity-card")).toHaveCount(0);
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
