import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, expect, webkit } from "@playwright/test";
import { Store } from "../apps/hub/dist/store.js";
import { teamPasswordHash } from "../apps/hub/dist/team-auth.js";
import { createTeamHub } from "../apps/hub/dist/team-hub.js";
import { configSchema } from "../packages/shared/dist/index.js";

const root = await mkdtemp(join(tmpdir(), "cw-team-ui-"));
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
  team: { enabled: true, root: join(root, "team") },
  auth: { username: "owner" },
  machines: [],
  projects: [],
});
const store = new Store(config.hub.databasePath),
  password = randomBytes(24).toString("base64url");
store.db.prepare("INSERT INTO users VALUES('owner',?)").run(await teamPasswordHash(password));
const hub = await createTeamHub(config, {
  store,
  socketRoot: join(root, "sock"),
  webRoot: resolve("apps/web/dist"),
});
await hub.app.listen({ host: "127.0.0.1", port });
await mkdir(".local/qa-team", { recursive: true });
try {
  for (const [engine, type] of [
    ["chromium", chromium],
    ["webkit", webkit],
  ]) {
    const browser = await type.launch();
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      serviceWorkers: "block",
    });
    const page = await context.newPage(),
      errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await page.goto(base);
      await page.evaluate(() => sessionStorage.setItem("codex-draft-identical", "OWNER_DRAFT"));
      await page.getByLabel("Логин", { exact: true }).fill("owner");
      await page.getByLabel("Пароль", { exact: true }).fill(password);
      await page.getByRole("button", { name: "Войти", exact: true }).click();
      await expect(page.locator(".login-page")).toHaveCount(0);
      await expect
        .poll(() => page.evaluate(() => sessionStorage.getItem("codex-workspace-identity")))
        .toBe(hub.registry.ownerId);
      assert.equal(
        await page.evaluate(
          (id) => sessionStorage.getItem(`cw-user:${id}:codex-draft-identical`),
          hub.registry.ownerId,
        ),
        "OWNER_DRAFT",
      );
      await page.getByRole("button", { name: "Настройки", exact: true }).last().click();
      await page.locator('[data-category="access"]').click();
      await expect(page.getByLabel("Участники установки")).toBeVisible();
      for (const [width, height] of [
        [390, 844],
        [1376, 1032],
        [1920, 1080],
      ]) {
        await page.setViewportSize({ width, height });
        for (const theme of ["organizer", "crt-green", "hitech-2000s", "classic-dark"]) {
          await page.evaluate((id) => {
            document.documentElement.dataset.theme = id;
            document.documentElement.dataset.caseColor = "purple";
          }, theme);
          await expect(page.getByLabel("Пригласить участника")).toBeVisible();
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
            false,
          );
          const panel = page.getByLabel("Участники установки");
          assert.equal(await panel.evaluate((el) => el.scrollWidth > el.clientWidth + 1), false);
          await page.screenshot({ path: `.local/qa-team/${engine}-${theme}-${width}.png` });
        }
      }
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByLabel("Пригласить участника").fill("Друг " + engine);
      await page.getByRole("button", { name: "Приглашение", exact: true }).click();
      const invitation = await page.getByLabel("Одноразовая ссылка").inputValue();
      await page.getByRole("button", { name: "Выйти", exact: true }).click();
      await expect(page.locator(".login-page")).toBeVisible();
      await page.goto(invitation);
      await page.getByLabel("Логин", { exact: true }).fill("friend_" + engine);
      await page.getByLabel("Твоё имя").fill("Друг " + engine);
      await page.getByLabel("Придумай пароль", { exact: true }).fill(password);
      await page.getByLabel("Повтори пароль").fill(password);
      await page.getByRole("button", { name: "Сохранить и войти" }).click();
      await expect(page.locator(".login-page")).toHaveCount(0);
      await expect
        .poll(() => page.evaluate(() => sessionStorage.getItem("codex-workspace-identity")))
        .not.toBe(hub.registry.ownerId);
      const friendId = hub.registry.byLogin("friend_" + engine).id;
      assert.equal(
        await page.evaluate(
          (id) => sessionStorage.getItem(`cw-user:${id}:codex-draft-identical`),
          friendId,
        ),
        null,
      );
      await page.getByRole("button", { name: "Настройки", exact: true }).last().click();
      await page.locator('[data-category="access"]').click();
      await expect(page.locator(".team-account strong")).toHaveText("Друг " + engine);
      await expect(page.getByLabel("Пригласить участника")).toHaveCount(0);
      await page.setViewportSize({ width: 1376, height: 1032 });
      await page.locator('[data-category="connections"]').click();
      await expect(page.getByLabel("Личные компьютеры")).toBeVisible();
      await expect(
        page.getByText("Администратору нужно завершить подключение Hub к Tailscale.", {
          exact: false,
        }),
      ).toBeVisible();
      config.team.hubTailnetAddress = "100.64.0.1";
      // Reopen the category to refresh immediately, without waiting for the polling interval.
      await page.locator('[data-category="access"]').click();
      await page.locator('[data-category="connections"]').click();
      await expect(page.getByLabel("Название компьютера")).toBeVisible();
      await page.getByLabel("Название компьютера").fill("Мой игровой компьютер " + engine);
      const download = page.waitForEvent("download");
      await page.getByRole("button", { name: "Подключить Windows ПК", exact: true }).click();
      assert.equal((await download).suggestedFilename(), "CodexWeb-Connect.zip");
      await expect(page.getByText("Ожидает запуска установщика", { exact: true })).toBeVisible();
      const enrollment = hub.enrollments.list(friendId)[0];
      const row = hub.enrollments.row(enrollment.id);
      const keys = JSON.parse(row.keys);
      const report = {
        version: 1,
        address: "100.64.0.2",
        hostKey: keys.commandPublic,
        machineGuid: crypto.randomUUID(),
        sid: "S-1-5-21-1-2-3-1001",
        username: "friend",
        profile: "C:\\Users\\Friend",
        roots: ["D:\\Projects"],
        readiness: {
          codex: true,
          companion: true,
          node: true,
          git: true,
          github: true,
          desktop: false,
        },
      };
      hub.registry.db
        .prepare("UPDATE team_machine_enrollments SET state='reported',report=? WHERE id=?")
        .run(JSON.stringify(report), row.id);
      await page.locator('[data-category="access"]').click();
      await page.locator('[data-category="connections"]').click();
      await expect(
        page.getByText("Ожидает подтверждения администратора", { exact: true }),
      ).toBeVisible();
      await expect(page.getByRole("button", { name: "Проверить", exact: true })).toHaveCount(0);
      for (const [width, height] of [
        [390, 844],
        [1376, 1032],
        [1920, 1080],
      ]) {
        await page.setViewportSize({ width, height });
        for (const theme of ["organizer", "crt-green", "hitech-2000s", "classic-dark"]) {
          await page.evaluate((id) => {
            document.documentElement.dataset.theme = id;
          }, theme);
          const panel = page.locator(".team-machines");
          assert.equal(await panel.evaluate((el) => el.scrollWidth > el.clientWidth + 1), false);
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
            false,
          );
          await panel.screenshot({
            path: `.local/qa-team/${engine}-machines-${theme}-${width}.png`,
          });
        }
      }
      config.team.hubTailnetAddress = undefined;
      assert.deepEqual(errors, []);
      console.log(
        engine +
          ": invitation, account switch, private drafts and 12 theme/viewport combinations passed",
      );
    } finally {
      await context.close();
      await browser.close();
    }
  }
} finally {
  await hub.app.close();
  await rm(root, { recursive: true, force: true });
}
