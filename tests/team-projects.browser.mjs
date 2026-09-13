import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, expect, webkit } from "@playwright/test";
import { Notebook } from "../apps/hub/dist/notebook.js";
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
const hub = await createTeamHub(config, {
  store,
  socketRoot: join(root, "sock"),
  webRoot: resolve("apps/web/dist"),
});
await hub.app.listen({ host: "127.0.0.1", port });
await mkdir(".local/qa-shared", { recursive: true });
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
try {
  for (const [engine, type] of [
    ["chromium", chromium],
    ["webkit", webkit],
  ]) {
    const browser = await type.launch(),
      context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        serviceWorkers: "block",
      }),
      other = await browser.newContext({
        viewport: { width: 1024, height: 768 },
        hasTouch: true,
        serviceWorkers: "block",
      });
    const page = await context.newPage(),
      friend = await other.newPage(),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    friend.on("pageerror", (e) => errors.push(e.message));
    try {
      await signIn(page, "owner");
      await signIn(friend, "friend");
      await page.evaluate(
        (id) => sessionStorage.setItem(`cw-user:${id}:codex-draft-identical`, "KEPT_DRAFT"),
        ownerId,
      );
      await open(page);
      await page.getByRole("button", { name: "Создать совместный проект", exact: true }).click();
      await page.getByLabel("Название", { exact: true }).fill("Общая игра " + engine);
      await page
        .locator(".shared-projects-dialog")
        .getByRole("button", { name: "Создать проект", exact: true })
        .click();
      await expect(page.locator(".shared-project-identity")).toContainText("Общая игра " + engine);
      const project = hub.teamProjects
        .list(ownerId)
        .items.find((p) => p.title === "Общая игра " + engine);
      await page.getByRole("button", { name: "Участники", exact: true }).click();
      await page.getByLabel("Логин в CodexWeb").fill("friend");
      await page.getByRole("button", { name: "Отправить приглашение", exact: true }).click();
      await expect(page.getByRole("status")).toContainText("Приглашение появится");
      assert.throws(() => hub.teamProjects.detail(friendId, project.id));
      await open(friend);
      await friend.getByRole("button", { name: "Принять приглашение", exact: true }).click();
      await expect(friend.locator(".shared-project-identity")).toContainText(
        "Общая игра " + engine,
      );
      await page.getByRole("button", { name: "Материалы", exact: true }).click();
      await page.getByLabel("Создать общий материал").selectOption("note");
      await page.getByLabel("Название", { exact: true }).fill("Заметка для участников");
      await page
        .getByLabel("Текст", { exact: true })
        .fill("Общий текст. Личная история остаётся у автора.");
      for (const [width, height] of [
        [390, 844],
        [768, 1024],
        [1024, 768],
        [1280, 800],
        [1376, 1032],
        [1920, 1080],
      ]) {
        await page.setViewportSize({ width, height });
        for (const theme of ["organizer", "crt-green", "hitech-2000s", "classic-dark"]) {
          await page.evaluate((theme) => {
            document.documentElement.dataset.theme = theme;
            document.documentElement.dataset.caseColor = "purple";
          }, theme);
          await expect(page.getByLabel("Закрыть совместные проекты")).toBeVisible();
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
            false,
          );
          assert.equal(
            await page
              .locator(".shared-scroll")
              .evaluate((el) => el.scrollWidth > el.clientWidth + 1),
            false,
            `${engine} ${theme} ${width}: panel width`,
          );
          await expect
            .poll(() =>
              page
                .locator(".notebook-heading")
                .evaluate(
                  (el) =>
                    getComputedStyle(el).color ===
                    getComputedStyle(el.querySelector('[aria-label="Закрыть совместные проекты"]'))
                      .color,
                ),
            )
            .toBe(true);
          await page.screenshot({ path: `.local/qa-shared/${engine}-${theme}-${width}.png` });
        }
      }
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByRole("button", { name: "Сохранить для участников", exact: true }).click();
      await expect(page.getByRole("button", { name: /Заметка для участников/ })).toBeVisible();
      await friend.getByRole("button", { name: "Обновить", exact: true }).click();
      await friend.getByRole("button", { name: /Заметка для участников/ }).click();
      await friend.getByRole("button", { name: "Редактор", exact: true }).click();
      await friend.getByLabel("Текст", { exact: true }).fill("Черновик друга при конфликте");
      const item = hub.teamProjects.items(ownerId, project.id, "note", "", 0).items[0];
      const latest = hub.teamProjects.get(ownerId, project.id, item.id);
      hub.teamProjects.put(ownerId, project.id, item.id, randomUUID(), {
        revision: latest.revision,
        content: { ...latest.content, body: "Новая версия владельца" },
        assigneeId: null,
      });
      await friend.getByRole("button", { name: "Сохранить для участников", exact: true }).click();
      await expect(friend.getByText("На сервере уже версия 2", { exact: true })).toBeVisible();
      await expect(friend.getByLabel("Текст", { exact: true })).toHaveValue(
        "Черновик друга при конфликте",
      );
      await friend.getByRole("button", { name: "Продолжить с моим текстом", exact: true }).click();
      await friend.getByRole("button", { name: "Сохранить для участников", exact: true }).click();
      await expect(friend.getByRole("button", { name: /Заметка для участников/ })).toBeVisible();
      assert.equal(
        hub.teamProjects.get(ownerId, project.id, item.id).content.body,
        "Черновик друга при конфликте",
      );
      // An unfinished structured plan survives close/reopen exactly, including empty points.
      await page.getByLabel("Создать общий материал").selectOption("plan");
      await page.getByRole("button", { name: "Добавить раздел", exact: true }).click();
      await page.getByRole("button", { name: "Добавить пункт", exact: true }).click();
      await page.getByLabel("Название", { exact: true }).fill("План с черновиком");
      await page.getByLabel("Пункт 1 раздела 1", { exact: true }).fill("");
      await page.getByRole("button", { name: "Закрыть совместные проекты", exact: true }).click();
      await open(page);
      await page
        .getByRole("article")
        .filter({ has: page.getByRole("heading", { name: "Общая игра " + engine, exact: true }) })
        .getByRole("button", { name: "Открыть проект" })
        .click();
      await page.getByLabel("Создать общий материал").selectOption("plan");
      await expect(page.getByLabel("Название", { exact: true })).toHaveValue("План с черновиком");
      await expect(page.getByLabel("Пункт 1 раздела 1", { exact: true })).toHaveValue("");
      await page.getByLabel("Пункт 1 раздела 1", { exact: true }).fill("Проверить интерфейс");
      await page.getByRole("button", { name: "Сохранить для участников", exact: true }).click();
      await expect(page.getByRole("button", { name: /План с черновиком/ })).toBeVisible();
      // Metadata fixture only: no machine or native writer is contacted by capture.
      const scope = {
        client: "codex",
        projectId: "fixture-source-" + engine,
        name: "Моя папка " + engine,
      };
      const personal = (await hub.personal(ownerId)).runtime;
      new Notebook(personal.sessions).save(randomUUID(), {
        scope,
        title: "Личная исходная заметка",
        body: "PRIVATE_SOURCE",
        revision: 0,
        links: [],
      });
      hub.teamProjects.bind(
        ownerId,
        project.id,
        randomUUID(),
        { revision: 0, personalProjectId: scope.projectId },
        { machineId: "FIXTURE_MACHINE", repository: null },
      );
      await page.getByRole("button", { name: "Закрыть совместные проекты", exact: true }).click();
      await page.evaluate(
        (scope) => window.dispatchEvent(new CustomEvent("open-quick-capture", { detail: scope })),
        scope,
      );
      await expect(page.getByLabel("Доступ к записи")).toHaveValue("shared");
      await page.getByLabel("Текст записи").fill("Общая быстрая запись " + engine);
      let dropped = false;
      await page.route("**/api/team/projects/*/materials/*", async (route) => {
        if (!dropped && route.request().method() === "PUT") {
          dropped = true;
          const response = await route.fetch();
          assert.equal(response.status(), 200);
          await route.abort("failed");
        } else await route.continue();
      });
      await page.getByRole("button", { name: "Сохранить", exact: true }).click();
      await expect(
        page.getByRole("button", { name: "Проверить сохранение", exact: true }),
      ).toBeVisible();
      await expect(page.getByLabel("Доступ к записи")).toHaveValue("shared");
      await page.reload();
      await expect(
        page.getByRole("button", { name: "Открыть проекты", exact: true }),
      ).toBeVisible();
      await page.evaluate(
        (scope) => window.dispatchEvent(new CustomEvent("open-quick-capture", { detail: scope })),
        scope,
      );
      await expect(page.getByLabel("Доступ к записи")).toHaveValue("shared");
      await page.getByRole("button", { name: "Проверить сохранение", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Сохранено", exact: true })).toBeVisible();
      assert.equal(
        hub.teamProjects.items(ownerId, project.id, "note", "Общая быстрая запись", 0).items.length,
        1,
      );
      assert.equal(
        new Notebook(personal.sessions).list("all", "Общая быстрая запись", 0).items.length,
        0,
      );
      await page.getByRole("button", { name: "Готово", exact: true }).click();
      await page.evaluate(
        (scope) => window.dispatchEvent(new CustomEvent("open-quick-capture", { detail: scope })),
        scope,
      );
      await expect(page.getByLabel("Доступ к записи")).toHaveValue("shared");
      await page.getByLabel("Доступ к записи").selectOption("personal");
      await page.getByLabel("Текст записи").fill("Личная быстрая запись " + engine);
      await page.getByRole("button", { name: "Сохранить", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Сохранено", exact: true })).toBeVisible();
      assert.equal(
        new Notebook(personal.sessions).list("all", "Личная быстрая запись " + engine, 0).items
          .length,
        1,
      );
      assert.equal(
        hub.teamProjects.items(friendId, project.id, "note", "Личная быстрая запись", 0).items
          .length,
        0,
      );
      await page.getByRole("button", { name: "Готово", exact: true }).click();
      await page.evaluate(
        (scope) =>
          window.dispatchEvent(
            new CustomEvent("open-workspace-materials", { detail: { scope, mode: "notes" } }),
          ),
        scope,
      );
      await expect(page.getByText("Общие материалы", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Мои личные материалы", exact: true }).click();
      await expect(
        page.getByRole("dialog", { name: "Заметки и ссылки", exact: true }),
      ).toBeVisible();
      await expect(page.getByText("Личная исходная заметка", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Новая заметка", exact: true }).click();
      await expect(page.getByLabel("Доступ к записи")).toHaveValue("personal");
      await page.getByRole("button", { name: "Закрыть заметки", exact: true }).click();
      await open(page);
      await page
        .getByRole("article")
        .filter({ has: page.getByRole("heading", { name: "Общая игра " + engine, exact: true }) })
        .getByRole("button", { name: "Открыть проект" })
        .click();
      await page.getByRole("button", { name: "Участники", exact: true }).click();
      await page.getByRole("button", { name: "Отозвать доступ", exact: true }).click();
      await page.getByRole("button", { name: "Подтвердить", exact: true }).click();
      await friend.getByRole("button", { name: "Обновить", exact: true }).click();
      await expect(
        friend.getByText("Проект или материал недоступен.", { exact: true }),
      ).toBeVisible();
      await expect(friend.getByRole("button", { name: /Заметка для участников/ })).toHaveCount(0);
      await page.getByRole("button", { name: "Закрыть совместные проекты", exact: true }).click();
      assert.equal(
        await page.evaluate(
          (id) => sessionStorage.getItem(`cw-user:${id}:codex-draft-identical`),
          ownerId,
        ),
        "KEPT_DRAFT",
      );
      assert.deepEqual(errors, []);
      console.log(
        `${engine}: real two-user projects, consent, edit conflict, incomplete Plan draft, revocation and 24 themed viewport combinations passed`,
      );
    } catch (error) {
      await page.screenshot({ path: `.local/qa-shared/${engine}-failure.png` });
      await friend.screenshot({ path: `.local/qa-shared/${engine}-friend-failure.png` });
      throw error;
    } finally {
      await context.close();
      await other.close();
      await browser.close();
    }
  }
} finally {
  await hub.app.close();
  await rm(root, { recursive: true, force: true });
}
