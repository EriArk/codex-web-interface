import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, expect, webkit } from "@playwright/test";
import { Store } from "../apps/hub/dist/store.js";
import { teamPasswordHash } from "../apps/hub/dist/team-auth.js";
import { createTeamHub } from "../apps/hub/dist/team-hub.js";
import { configSchema } from "../packages/shared/dist/index.js";

const root = await mkdtemp(join(tmpdir(), "cw-shared-ui-")),
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
store.db.prepare("INSERT INTO users VALUES('owner',?)").run(await teamPasswordHash(password));
const calls = [],
  receipts = new Map();
const hub = await createTeamHub(config, {
  githubProbe,
  store,
  socketRoot: join(root, "sock"),
  webRoot: resolve("apps/web/dist"),
});
await hub.app.listen({ host: "127.0.0.1", port });
await mkdir(".local/qa-github", { recursive: true });
async function request(path, body, identity = {}) {
  const res = await fetch(base + "/api" + path, {
    method: "POST",
    headers: { origin: base, "content-type": "application/json", ...identity },
    body: JSON.stringify(body),
  });
  const value = await res.json();
  assert.equal(res.status, 200, JSON.stringify(value));
  return { value, cookie: res.headers.get("set-cookie")?.split(";")[0] };
}
const login = await request("/auth/login", { login: "owner", password });
const invite = await request(
  "/team/invitations",
  { name: "Друг" },
  { cookie: login.cookie, "x-csrf-token": login.value.csrf },
);
await request("/auth/join", {
  token: new URL(invite.value.url).hash.slice(6),
  login: "friend",
  name: "Друг",
  password,
});
const ownerId = hub.registry.ownerId,
  friendId = hub.registry.byLogin("friend").id;
async function signIn(page, login) {
  await page.goto(base);
  await page.getByLabel("Логин", { exact: true }).fill(login);
  await page.getByLabel("Пароль", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page.locator(".login-page")).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => sessionStorage.getItem("codex-workspace-identity")))
    .toBe(login === "owner" ? ownerId : friendId);
}
async function open(page) {
  const button = page.getByRole("button", { name: "Совместные проекты", exact: true });
  if (!(await button.isVisible()))
    await page.getByRole("button", { name: "Открыть проекты", exact: true }).click();
  await button.click();
  await expect(page.getByRole("dialog", { name: "Совместные проекты", exact: true })).toBeVisible();
}
async function githubProbe(machine, root, req) {
  const login = root.endsWith("owner") ? "Owner" : "Friend";
  calls.push({ login, req });
  const snapshot = {
    repository: req.repository,
    repositoryId: 71,
    identity: { id: login === "Owner" ? 11 : 22, login },
    access: login === "Owner" ? "admin" : "write",
    issues: true,
    checkedAt: Date.now(),
  };
  const record = {
    type: "pr",
    number: 12,
    title: "Поддержка маленького планшета",
    body: "Проверить отступы и сохранить состояние чата.",
    truncated: false,
    author: { id: 22, login: "Friend" },
    state: "open",
    url: "https://github.com/Owner/Project/pull/12",
    createdAt: "2026-09-13T00:00:00Z",
    updatedAt: "2026-09-13T01:00:00Z",
    comments: 1,
    assignees: ["Friend"],
    labels: ["interface"],
    head: { branch: "tablet-layout", sha: "a".repeat(40), repository: "Owner/Project" },
    base: "main",
    reviewers: ["Owner"],
    reviews: [{ author: "Owner", state: "COMMENTED", sha: "b".repeat(40) }],
    checks: [{ name: "Local verification", state: "success", sha: "a".repeat(40) }],
    checksKnown: true,
  };
  if (req.op === "observe")
    return {
      ...snapshot,
      query: req.query,
      ...(req.query.kind === "list" ? { items: [record], nextPage: null } : {}),
      ...(req.query.kind === "detail"
        ? {
            record,
            commentsPage: [
              {
                id: 3000000001,
                author: { id: 11, login: "Owner" },
                body: "Обсуждение изменений",
                truncated: false,
                createdAt: record.createdAt,
                url: record.url + "#issuecomment-3000000001",
              },
            ],
          }
        : {}),
      ...(req.query.kind === "collaborators"
        ? { collaborators: [{ login: "Friend", state: "accepted", permission: "write" }] }
        : {}),
    };
  if (req.op === "prepare") {
    if (!receipts.has(req.id))
      receipts.set(req.id, {
        id: req.id,
        input: req.input,
        snapshot,
        fingerprint: "c".repeat(64),
        state: "prepared",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        ...("number" in req.input ? { baseline: record } : {}),
      });
  }
  if (req.op === "apply") {
    receipts.get(req.id).state = "completed";
    receipts.get(req.id).result = {
      url: "https://github.com/Owner/Project/issues/31",
      number: 31,
      state: "open",
    };
  }
  return structuredClone(receipts.get(req.id) ?? null);
}
try {
  for (const [engine, type] of [
    ["chromium", chromium],
    ["webkit", webkit],
  ]) {
    const projectId = randomUUID(),
      nativeId = "github-" + engine;
    hub.teamProjects.create(ownerId, projectId, {
      title: "Командная игра " + engine,
      visibility: "shared",
      repository: "https://github.com/Owner/Project",
    });
    const invite = hub.teamProjects.invite(ownerId, projectId, randomUUID(), {
      login: "friend",
      role: "collaborator",
      revision: 1,
    });
    hub.teamProjects.answerInvitation(friendId, invite.id, randomUUID(), true);
    for (const [userId, name] of [
      [ownerId, "owner"],
      [friendId, "friend"],
    ]) {
      const personal = (await hub.personal(userId)).runtime,
        folder = join(root, engine, name);
      await mkdir(folder, { recursive: true });
      personal.sessions.config.machines.push({
        id: nativeId,
        name: "Мой компьютер",
        type: "local-linux",
        allowedProjectRoots: [folder],
        codex: {},
      });
      personal.sessions.config.projects.push({
        id: nativeId,
        name: "My private checkout",
        machineId: nativeId,
        workingDirectory: folder,
        enabled: true,
      });
      hub.teamProjects.bind(
        userId,
        projectId,
        randomUUID(),
        { revision: 0, personalProjectId: nativeId },
        { machineId: nativeId, repository: "https://github.com/Owner/Project" },
      );
    }
    const browser = await type.launch(),
      contexts = await Promise.all(
        [390, 1024].map((width) =>
          browser.newContext({
            viewport: { width, height: 844 },
            hasTouch: true,
            serviceWorkers: "block",
          }),
        ),
      ),
      [page, friend] = await Promise.all(contexts.map((c) => c.newPage())),
      errors = [];
    for (const p of [page, friend]) p.on("pageerror", (e) => errors.push(e.message));
    const openGitHub = async (p) => {
      await p.evaluate(
        (id) =>
          window.dispatchEvent(
            new CustomEvent("open-shared-projects", { detail: { projectId: id, github: {} } }),
          ),
        projectId,
      );
      await expect(p.getByRole("region", { name: "GitHub проекта" })).toBeVisible();
    };
    try {
      await signIn(page, "owner");
      await signIn(friend, "friend");
      await openGitHub(page);
      await openGitHub(friend);
      await page.getByRole("button", { name: "Проверить мой доступ" }).click();
      await friend.getByRole("button", { name: "Проверить мой доступ" }).click();
      await expect(page.locator(".github-workspace")).toContainText("@Owner");
      await expect(friend.locator(".github-workspace")).toContainText("@Friend");
      await friend.getByRole("button", { name: "Это мой GitHub — показать участникам" }).click();
      await expect.poll(() => hub.teamGitHub.page(ownerId, projectId).accounts.length).toBe(1);
      await page.getByRole("button", { name: "Pull requests", exact: true }).click();
      await page.getByRole("button", { name: "Загрузить PR", exact: true }).click();
      await page.getByRole("button", { name: /#12 · Поддержка/ }).click();
      await expect(page.locator(".github-sha")).toContainText("a".repeat(40));
      await page.getByRole("button", { name: "Связать с проектом", exact: true }).click();
      await expect(page.getByRole("button", { name: "В мой план работы" })).toBeVisible();
      await page.getByRole("button", { name: "Написать комментарий" }).click();
      await page
        .getByLabel("Текст для GitHub", { exact: true })
        .fill("Только выбранный публичный комментарий");
      let drop = true;
      await page.route("**/github/operations/*", async (route) => {
        if (route.request().method() === "PUT" && drop) {
          drop = false;
          await route.fetch();
          await route.abort("failed");
        } else await route.continue();
      });
      await page.getByRole("button", { name: "Проверить перед отправкой", exact: true }).click();
      await expect
        .poll(() => hub.teamGitHub.page(ownerId, projectId).operations[0]?.state)
        .toBe("prepared");
      const prepared = hub.teamGitHub.page(ownerId, projectId).operations[0];
      assert.equal(prepared.state, "prepared");
      await page.getByRole("button", { name: "Закрыть совместные проекты" }).click();
      await openGitHub(page);
      await expect(page.locator(".github-compose")).toContainText(
        "Только выбранный публичный комментарий",
      );
      assert.equal(calls.filter((v) => v.req.op === "apply" && v.req.id === prepared.id).length, 0);
      for (const theme of ["organizer", "crt-green", "hitech-2000s", "classic-dark"]) {
        for (const width of [390, 1024]) {
          await page.setViewportSize({ width, height: width === 390 ? 844 : 768 });
          await page.evaluate((theme) => {
            document.documentElement.dataset.theme = theme;
            document.documentElement.dataset.caseColor = "blue";
          }, theme);
          await page.locator(".github-compose").scrollIntoViewIfNeeded();
          const overflow = await page
            .locator(".shared-scroll")
            .evaluate((e) => e.scrollWidth - e.clientWidth);
          assert(overflow <= 2, `${theme}/${width} overflow ${overflow}`);
          await page.screenshot({
            path: `.local/qa-github/${engine}-${theme}-${width}.png`,
            animations: "disabled",
          });
        }
      }
      await page.getByRole("button", { name: "Подтвердить в GitHub", exact: true }).click();
      await expect(page.locator(".github-compose")).toContainText("Выполнено");
      assert.equal(calls.filter((v) => v.req.op === "apply" && v.req.id === prepared.id).length, 1);
      await page.getByRole("button", { name: "Новый черновик", exact: true }).click();
      const materialId = randomUUID();
      hub.teamProjects.put(ownerId, projectId, materialId, randomUUID(), {
        revision: 0,
        assigneeId: null,
        content: { kind: "note", title: "Контрольная точка", body: "Только выбранный материал" },
      });
      await page.evaluate(
        ({ projectId, materialId }) =>
          window.dispatchEvent(
            new CustomEvent("open-shared-projects", {
              detail: { projectId, github: { source: { kind: "material", id: materialId } } },
            }),
          ),
        { projectId, materialId },
      );
      await page
        .getByRole("button", { name: "Просмотреть и подготовить issue", exact: true })
        .click();
      await expect(page.getByLabel("Текст для GitHub", { exact: true })).toHaveValue(
        "Только выбранный материал",
      );
      await page
        .getByLabel("Текст для GitHub", { exact: true })
        .fill("Исправленный публичный итог");
      await page.getByRole("button", { name: "Проверить перед отправкой", exact: true }).click();
      await expect(page.locator(".github-compose")).toContainText("Исправленный публичный итог");
      await page.getByRole("button", { name: "Отменить подготовку", exact: true }).click();
      await expect(page.locator(".github-compose")).toContainText("Подготовка отменена");
      await openGitHub(friend);
      await expect(
        friend.getByRole("button", { name: "В мой план работы", exact: true }),
      ).toBeVisible();
      await friend.getByRole("button", { name: "В мой план работы", exact: true }).click();
      await expect(friend.locator(".shared-editor-layout")).toContainText("Точный SHA");
      const plan = hub.teamProjects.items(friendId, projectId, "plan", "", 0).items[0];
      assert.equal(plan.assigneeId, friendId);
      assert.equal(hub.teamGitHub.page(friendId, projectId).operations.length, 0);
      assert.deepEqual(errors, []);
      console.log(
        `${engine}: two identities, exact SHA, publication checkpoint, lost prepare acknowledgement and durable draft, explicit send, assigned Plan, 8 themed viewport cases passed`,
      );
    } catch (e) {
      console.error(errors, await page.locator(".shared-projects-dialog").ariaSnapshot());
      await page.screenshot({ path: `.local/qa-github/${engine}-failure.png` });
      throw e;
    } finally {
      await Promise.all(contexts.map((c) => c.close()));
      await browser.close();
    }
  }
} finally {
  await hub.app.close();
  await rm(root, { recursive: true, force: true });
}
