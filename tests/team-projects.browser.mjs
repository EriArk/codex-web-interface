import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, expect, webkit } from "@playwright/test";
import { Artifacts } from "../apps/hub/dist/artifacts.js";
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
      await page
        .getByRole("group", { name: "Пользователи Hub", exact: true })
        .getByRole("button", { name: /Друг/ })
        .click();
      await page.getByRole("button", { name: "Отправить приглашение", exact: true }).click();
      await expect(page.locator(".shared-projects-dialog").getByRole("status")).toContainText(
        "Приглашение появится",
      );
      assert.throws(() => hub.teamProjects.detail(friendId, project.id));
      await open(friend);
      await friend.getByRole("button", { name: "Принять приглашение", exact: true }).click();
      await expect(friend.locator(".shared-project-identity")).toContainText(
        "Общая игра " + engine,
      );
      const linkedProjectId = randomUUID();
      hub.teamProjects.create(friendId, linkedProjectId, {
        title: "Личный связанный " + engine,
        visibility: "private",
        repository: null,
      });
      await page.getByRole("button", { name: "Связи проектов", exact: true }).click();
      await page.getByRole("button", { name: "Предложить связь", exact: true }).click();
      await page
        .getByRole("group", { name: "Пользователи Hub", exact: true })
        .getByRole("button", { name: /Друг/ })
        .click();
      await page.getByLabel("Для чего связываем проекты").fill("Согласовать общий API");
      await page.getByRole("button", { name: "Отправить предложение", exact: true }).click();
      await expect(page.getByText("Ждёт выбора проекта", { exact: true })).toBeVisible();
      await friend.evaluate(() =>
        window.dispatchEvent(new CustomEvent("open-shared-projects", { detail: {} })),
      );
      await friend
        .getByLabel("Мой проект для связи", { exact: true })
        .selectOption(linkedProjectId);
      await friend.getByRole("button", { name: "Принять связь", exact: true }).click();
      await expect(friend.getByRole("button", { name: "Принять связь", exact: true })).toHaveCount(
        0,
      );
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect(
        page.getByRole("heading", {
          name: "Общая игра " + engine + " ↔ Личный связанный " + engine,
          exact: true,
        }),
      ).toBeVisible();
      assert.throws(() => hub.teamProjects.detail(ownerId, linkedProjectId));
      const link = hub.teamLinks.page(ownerId, project.id).items[0];
      await page.getByRole("button", { name: "Консультации", exact: true }).click();
      await page.getByRole("button", { name: "Новый запрос", exact: true }).click();
      await page.getByLabel("Связь для запроса", { exact: true }).selectOption(link.id);
      await page.getByLabel("Тема", { exact: true }).fill("Уточнить API " + engine);
      await page
        .getByLabel("Вопрос и общий контекст", { exact: true })
        .fill("Какие поля у публичного интерфейса?");
      await page.getByRole("button", { name: "Передать запрос", exact: true }).click();
      await expect(
        page.getByRole("heading", { name: "Уточнить API " + engine, exact: true }),
      ).toBeVisible();
      await expect(page.locator(".shared-projects-dialog").getByRole("status")).toContainText(
        "Ждёт согласия владельцев",
      );
      await friend.evaluate(
        (projectId) =>
          window.dispatchEvent(new CustomEvent("open-shared-projects", { detail: { projectId } })),
        linkedProjectId,
      );
      await friend.getByRole("button", { name: "Консультации", exact: true }).click();
      await friend.getByRole("button", { name: /Уточнить API/ }).click();
      await expect(
        friend.getByRole("button", { name: "Разрешить консультацию моему проекту", exact: true }),
      ).toBeVisible();
      await friend.getByRole("button", { name: "Остановить обмен", exact: true }).click();
      await expect(friend.locator(".shared-projects-dialog").getByRole("status")).toContainText(
        "Остановлено",
      );
      assert.equal(hub.teamConsultations.page(ownerId, project.id).items[0].state, "stopped");
      await friend.evaluate(
        (projectId) =>
          window.dispatchEvent(new CustomEvent("open-shared-projects", { detail: { projectId } })),
        project.id,
      );
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
      await friend.evaluate(() => window.dispatchEvent(new Event("focus")));
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
      // Real local root verification + held-queue UI. The fixture thread is marked busy;
      // no native process is acquired, and explicit cancellation removes its pending dispatch.
      const folder = join(root, "checkout-" + engine);
      await mkdir(folder);
      personal.sessions.config.machines.push({
        id: "FIXTURE_MACHINE",
        name: "Fixture",
        type: "local-linux",
        allowedProjectRoots: [folder],
        codex: {},
      });
      personal.sessions.config.projects.push({
        id: scope.projectId,
        name: scope.name,
        machineId: "FIXTURE_MACHINE",
        workingDirectory: folder,
        enabled: true,
      });
      const nativeThread = personal.store.createThread(
        scope.projectId,
        randomUUID(),
        "My execution chat",
      );
      personal.store.setThreadSettings(nativeThread.id, {
        model: "fixture-model",
        effort: "high",
        mode: "default",
        access: "workspace",
      });
      personal.store.setStatus(nativeThread.id, "running");
      const sharedPlan = hub.teamProjects.items(ownerId, project.id, "plan", "", 0).items[0];
      const beforeRun = hub.teamProjects.get(ownerId, project.id, sharedPlan.id);
      hub.teamProjects.put(ownerId, project.id, sharedPlan.id, randomUUID(), {
        content: beforeRun.content,
        revision: beforeRun.revision,
        assigneeId: ownerId,
      });
      await page.evaluate(
        (target) =>
          window.dispatchEvent(new CustomEvent("open-shared-projects", { detail: target })),
        { projectId: project.id, kind: "plan", itemId: sharedPlan.id },
      );
      await expect(
        page.getByRole("button", { name: "Подготовить выполнение", exact: true }),
      ).toBeEnabled();
      await page.getByRole("button", { name: "Подготовить выполнение", exact: true }).click();
      await expect(
        page.getByRole("button", { name: "Подтвердить и выполнить", exact: true }),
      ).toBeVisible();
      await page.getByText("Текст задания и согласованная основа", { exact: true }).click();
      await expect(page.locator(".shared-run-prompt")).toContainText("Проверить интерфейс");
      await page.getByRole("button", { name: "Подтвердить и выполнить", exact: true }).click();
      await expect(page.locator('.shared-execution [data-state="queued"]')).toBeVisible();
      const receipt = hub.teamExecutions.list(ownerId, project.id, sharedPlan.id).items[0];
      const privateView = await hub.teamExecutions.detail(friendId, project.id, receipt.id);
      assert.equal(privateView.preview, undefined);
      await page.getByRole("button", { name: "Отменить запуск", exact: true }).click();
      await expect(page.locator('.shared-execution [data-state="cancelled"]')).toBeVisible();
      assert.equal(
        personal.store.db
          .prepare("SELECT count(*) n FROM messages WHERE threadId=?")
          .get(nativeThread.id).n,
        0,
      );
      personal.store.setStatus(nativeThread.id, "idle");
      personal.sessions.config.machines = personal.sessions.config.machines.filter(
        (m) => m.id !== "FIXTURE_MACHINE",
      );
      personal.sessions.config.projects = personal.sessions.config.projects.filter(
        (p) => p.id !== scope.projectId,
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
      new Artifacts(personal.sessions.config.hub.resultsPath, personal.store).putFile(
        nativeThread.id,
        null,
        "Общий файл.txt",
        "/private/fixture.txt",
        "text/plain",
        Buffer.from("EXPLICIT_PUBLISHED_FILE"),
      );
      await page.evaluate(
        (target) =>
          window.dispatchEvent(new CustomEvent("open-shared-projects", { detail: target })),
        { projectId: project.id, scope },
      );
      await page.getByRole("button", { name: "Опубликовать из личного", exact: true }).click();
      await page.getByLabel("Раздел", { exact: true }).selectOption("file");
      await page.getByRole("checkbox", { name: "Общий файл.txt", exact: true }).check();
      await page
        .getByRole("button", { name: "Просмотреть перед публикацией", exact: true })
        .click();
      await expect(page.locator(".shared-file")).toContainText("Общий файл.txt");
      await page.getByRole("button", { name: "Опубликовать для участников", exact: true }).click();
      await expect(
        page.getByRole("button", { name: "Опубликовать для участников", exact: true }),
      ).toHaveCount(0);
      const publishedFile = hub.teamProjects.items(friendId, project.id, "result", "Общий файл", 0)
        .items[0];
      assert(publishedFile);
      await friend.evaluate(
        (target) =>
          window.dispatchEvent(new CustomEvent("open-shared-projects", { detail: target })),
        { projectId: project.id, itemId: publishedFile.id, kind: "result" },
      );
      await expect(friend.locator(".shared-file")).toContainText("Общий файл.txt");
      const downloaded = await friend.request.get(
        base + (await friend.locator(".shared-file").getAttribute("href")),
      );
      assert.equal(await downloaded.text(), "EXPLICIT_PUBLISHED_FILE");
      await page.getByRole("button", { name: "Закрыть совместные проекты", exact: true }).click();
      await open(page);
      await page
        .getByRole("article")
        .filter({ has: page.getByRole("heading", { name: "Общая игра " + engine, exact: true }) })
        .getByRole("button", { name: "Открыть проект" })
        .click();
      await page.getByRole("button", { name: "Участники", exact: true }).click();
      await page.getByRole("button", { name: "Отозвать доступ", exact: true }).click();
      await page.getByRole("button", { name: "Подтвердить", exact: true }).click();
      await friend.evaluate(() => window.dispatchEvent(new Event("focus")));
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
