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

const root = await mkdtemp(join(tmpdir(), "cw-offboarding-"));
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
await mkdir(".local/qa-offboarding", { recursive: true });
try {
  for (const [engine, type] of [
    ["chromium", chromium],
    ["webkit", webkit],
  ]) {
    const friend = hub.registry.accept(
      hub.registry.invite(hub.registry.ownerId, "Друг").token,
      engine,
      "Друг",
      hash,
      10,
    );
    const project = randomUUID();
    hub.teamProjects.create(friend.id, project, {
      title: "PRIVATE_TO_MEMBER",
      visibility: "shared",
      repository: null,
    });
    const browser = await type.launch();
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      serviceWorkers: "block",
    });
    try {
      await page.goto(base);
      await page.getByLabel("Логин", { exact: true }).fill("eriark");
      await page.getByLabel("Пароль", { exact: true }).fill(password);
      await page.getByRole("button", { name: "Войти", exact: true }).click();
      await expect(page.locator(".login-page")).toHaveCount(0);
      await expect
        .poll(() => page.evaluate(() => sessionStorage.getItem("codex-workspace-identity")))
        .toBe(hub.registry.ownerId);
      const settings = page.getByRole("button", { name: "Настройки", exact: true }).last();
      if (!(await settings.isVisible()))
        await page.getByRole("button", { name: "Открыть проекты", exact: true }).click();
      await page.getByRole("button", { name: "Настройки", exact: true }).last().click();
      await page.locator('[data-category="access"]').click();
      const row = page.locator(".team-people > li").filter({ hasText: engine }).first();
      await row.getByRole("button", { name: "Закрыть доступ", exact: true }).click();
      const panel = page.getByLabel("Подтверждение изменения доступа");
      await expect(
        panel.getByText("Сначала нужно передать или архивировать общие проекты: 1."),
      ).toBeVisible();
      await expect(panel).not.toContainText("PRIVATE_TO_MEMBER");
      for (const width of [390, 1024]) {
        await page.setViewportSize({ width, height: 844 });
        await page.evaluate(() => {
          document.documentElement.dataset.theme = "crt-green";
        });
        assert.equal(await panel.evaluate((el) => el.scrollWidth > el.clientWidth + 1), false);
        await panel.screenshot({ path: `.local/qa-offboarding/${engine}-${width}.png` });
      }
      await panel.getByRole("button", { name: "Подтвердить", exact: true }).click();
      await expect(
        page.getByText("Сначала передай или архивируй общие проекты пользователя.", {
          exact: true,
        }),
      ).toBeVisible();
      hub.registry.db.prepare("UPDATE team_projects SET archived=1 WHERE id=?").run(project);
      await panel.getByRole("button", { name: "Подтвердить", exact: true }).click();
      await expect(row.getByRole("button", { name: "Вернуть доступ", exact: true })).toBeVisible();
      await row.getByRole("button", { name: "Вернуть доступ", exact: true }).click();
      await expect(panel).toContainText("Потребуется новый вход");
      await panel.getByRole("button", { name: "Подтвердить", exact: true }).click();
      await expect(row.getByRole("button", { name: "Закрыть доступ", exact: true })).toBeVisible();
      console.log(
        `${engine}: offboarding summary, ownership conflict, disable and re-enable passed`,
      );
    } catch (error) {
      await page.screenshot({ path: `.local/qa-offboarding/${engine}-failure.png` });
      console.error(await page.locator("body").innerText());
      throw error;
    } finally {
      await browser.close();
    }
  }
} finally {
  await hub.app.close();
  await rm(root, { recursive: true, force: true });
}
