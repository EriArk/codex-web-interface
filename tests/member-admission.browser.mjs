import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, expect, webkit } from "@playwright/test";
import { Store } from "../apps/hub/dist/store.js";
import { teamPasswordHash } from "../apps/hub/dist/team-auth.js";
import { createTeamHub } from "../apps/hub/dist/team-hub.js";
import { configSchema } from "../packages/shared/dist/index.js";

for (const [engine, type] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
  if (process.env.BROWSER && process.env.BROWSER !== engine) continue;
  const root = await mkdtemp(join(tmpdir(), "cw-admission-"));
  const probe = createServer();
  await new Promise((done) => probe.listen(0, "127.0.0.1", done));
  const port = probe.address().port;
  await new Promise((done) => probe.close(done));
  const base = `http://127.0.0.1:${port}`;
  const config = configSchema.parse({
    hub: {
      publicBaseUrl: base,
      secureCookies: false,
      databasePath: join(root, "owner.db"),
      resultsPath: join(root, "files"),
    },
    team: {
      enabled: true,
      root: join(root, "team"),
      hubTailnetAddress: "100.64.0.1",
      gptProfiles: { enabled: true, runtime: "native", maxProfiles: 4 },
    },
    auth: { username: "owner", ownerLogin: "eriark" },
    machines: [],
    projects: [],
  });
  const store = new Store(config.hub.databasePath),
    password = randomUUID();
  const hash = await teamPasswordHash(password);
  store.db.prepare("INSERT INTO users VALUES('owner',?)").run(hash);
  const hub = await createTeamHub(config, {
    store,
    socketRoot: join(root, "sock"),
    webRoot: resolve("apps/web/dist"),
  });
  await hub.app.listen({ host: "127.0.0.1", port });
  await mkdir(".local/qa-admission", { recursive: true });
  const browser = await type.launch();
  const ownerContext = await browser.newContext({
    viewport: { width: 1376, height: 1032 },
    hasTouch: true,
    serviceWorkers: "block",
  });
  const friendContext = await browser.newContext({
    viewport: { width: 768, height: 1024 },
    hasTouch: true,
    serviceWorkers: "block",
  });
  const owner = await ownerContext.newPage(),
    friend = await friendContext.newPage();
  const button = (page, name) =>
    page.getByRole("button", { name, exact: true }).filter({ visible: true }).first();
  const settings = async (page) => {
    if (!(await button(page, "Настройки").isVisible()))
      await button(page, "Открыть проекты").click();
    await button(page, "Настройки").click();
    await page.locator('[data-category="access"]').click();
  };
  const shared = async (page) => {
    if (!(await button(page, "Общие проекты").isVisible()))
      await button(page, "Открыть проекты").click();
    await button(page, "Общие проекты").click();
  };
  try {
    await owner.goto(base + "/#setup");
    await owner.getByLabel("Логин", { exact: true }).fill("eriark");
    await owner.getByLabel("Пароль", { exact: true }).fill(password);
    await button(owner, "Войти").click();
    await expect(owner.locator(".desktop-nav")).toBeVisible();
    await expect(
      owner.getByRole("dialog", { name: "Настройка рабочего пространства" }),
    ).toHaveCount(0);
    // Visual evidence for the owner-requested slightly wider shared navigation.
    for (const theme of ["crt-green", "hitech-2000s"]) {
      await owner.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
      }, theme);
      await owner.screenshot({ path: `.local/qa-admission/${engine}-${theme}-wide.png` });
      assert.equal(
        await owner
          .locator(".desktop-nav .workspace-shortcuts")
          .evaluate((el) => el.scrollWidth > el.clientWidth + 1),
        false,
      );
      assert.equal(
        await owner.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
    }
    const wide = await owner.locator(".desktop-nav").boundingBox();
    console.log(`${engine}: wide navigation ${Math.round(wide.width)}px at 1376px`);
    await settings(owner);
    await expect(owner.getByLabel("Участники установки")).toContainText("Владелец установки");
    await owner.getByLabel("Пригласить участника").fill("Друг");
    await button(owner, "Приглашение").click();
    const invitation = await owner.getByLabel("Одноразовая ссылка").inputValue();
    await friend.goto(invitation);
    await friend.getByLabel("Логин", { exact: true }).fill("friend");
    await friend.getByLabel("Твоё имя").fill("Друг");
    await friend.getByLabel("Придумай пароль", { exact: true }).fill(password);
    await friend.getByLabel("Повтори пароль").fill(password);
    await button(friend, "Сохранить и войти").click();
    const setup = friend.getByRole("dialog", { name: "Настройка рабочего пространства" });
    await expect(setup).toBeVisible();
    await setup.getByRole("button", { name: "Позже", exact: true }).click();
    await button(owner, "Закрыть настройки").click();
    await shared(owner);
    await button(owner, "Создать совместный проект").click();
    await owner.getByLabel("Название", { exact: true }).fill("Проверка совместной работы");
    await owner
      .getByRole("dialog", { name: "Общие проекты", exact: true })
      .getByRole("button", { name: "Создать проект", exact: true })
      .click();
    await expect(owner.locator(".shared-project-identity")).toContainText(
      "Проверка совместной работы",
    );
    await button(owner, "Участники").click();
    await owner
      .getByRole("group", { name: "Пользователи Hub", exact: true })
      .getByRole("button", { name: /Друг/ })
      .click();
    await button(owner, "Отправить приглашение").click();
    await expect(owner.locator(".shared-projects-dialog").getByRole("status")).toContainText(
      "Приглашение появится",
    );
    const project = hub.teamProjects.list(hub.registry.ownerId).items[0];
    const friendId = hub.registry.byLogin("friend").id;
    await expect
      .poll(() => {
        try {
          hub.teamProjects.detail(friendId, project.id);
          return false;
        } catch {
          return true;
        }
      })
      .toBe(true);
    await shared(friend);
    await button(friend, "Принять приглашение").click();
    await expect(friend.locator(".shared-project-identity")).toContainText(
      "Проверка совместной работы",
    );
    assert.equal(
      hub.teamProjects.detail(friendId, project.id).project.ownerId,
      hub.registry.ownerId,
    );
    await button(owner, "Материалы").click();
    await owner.getByLabel("Создать общий материал").selectOption("note");
    await owner.getByLabel("Название", { exact: true }).fill("Общая заметка");
    await owner.getByLabel("Текст", { exact: true }).fill("Только опубликованное содержимое");
    await button(owner, "Сохранить для участников").click();
    await expect(owner.getByRole("button", { name: /Общая заметка/ })).toBeVisible();
    await friend.evaluate(() => window.dispatchEvent(new Event("focus")));
    await friend.getByRole("button", { name: /Общая заметка/ }).click();
    await expect(friend.locator(".shared-projects-dialog")).toContainText(
      "Только опубликованное содержимое",
    );
    await button(friend, "Закрыть совместные проекты").click();
    for (const [width, height] of [
      [768, 1024],
      [1024, 768],
    ]) {
      await friend.setViewportSize({ width, height });
      await friend.evaluate(() => window.dispatchEvent(new Event("resize")));
      if (!(await friend.locator(".project-sheet:visible").count()))
        await button(friend, "Открыть проекты").click();
      await friend.screenshot({ path: `.local/qa-admission/${engine}-drawer-${width}.png` });
      assert.equal(
        await friend.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
    }
    await button(owner, "Участники").click();
    await button(owner, "Отозвать доступ").click();
    await button(owner, "Подтвердить").click();
    assert.throws(() => hub.teamProjects.detail(friendId, project.id));
    assert.equal(hub.registry.user(hub.registry.ownerId).role, "admin");
    console.log(
      `${engine}: invitation registration, owner bypass, deferred setup, shared consent/material and revocation passed`,
    );
  } catch (e) {
    console.error(await owner.locator("body").innerText());
    console.error(await friend.locator("body").innerText());
    await owner.screenshot({ path: `.local/qa-admission/${engine}-failure.png` });
    throw e;
  } finally {
    await browser.close();
    await hub.app.close();
    await rm(root, { recursive: true, force: true });
  }
}
