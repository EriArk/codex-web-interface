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
    const cfg = configSchema.parse({
      ...selected,
      machines: [{ id: "pc", name: "Local", type: "local-linux", allowedRoots: [root] }],
      projects: [
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
page.setDefaultTimeout(8000);
other.setDefaultTimeout(8000);
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
  return p.locator(".navigation-inner:visible");
}
try {
  await login(page, "owner");
  await login(other, "friend");
  const nav = await drawer(page);
  await nav.getByRole("button", { name: "Общие пространства", exact: true }).click();
  await nav.getByRole("button", { name: "Создать пространство", exact: true }).click();
  let dialog = page.locator(".space-dialog");
  await dialog.getByLabel("Название", { exact: true }).fill("Altar + World");
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
  await otherNav.getByRole("button", { name: "Приглашения: 1", exact: true }).click();
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
    "WebKit phone/tablet: create, existing project wizard return, invite, accept, native identity continuity, leave passed.",
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
