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
  const root = await mkdtemp(join(tmpdir(), "cw-onboarding-"));
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
  await mkdir(".local/qa-onboarding", { recursive: true });
  try {
    const friend = hub.registry.accept(
      hub.registry.invite(hub.registry.ownerId, "Друг").token,
      engine,
      "Друг",
      hash,
      10,
    );
    const browser = await type.launch();
    let context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      serviceWorkers: "block",
    });
    let page = await context.newPage();
    const login = async (suffix = "") => {
      await page.goto(base + suffix);
      await page.getByLabel("Логин", { exact: true }).fill(engine);
      await page.getByLabel("Пароль", { exact: true }).fill(password);
      await page.getByRole("button", { name: "Войти", exact: true }).click();
      await expect
        .poll(() =>
          page.evaluate(() => sessionStorage.getItem("codex-workspace-identity")).catch(() => null),
        )
        .toBe(friend.id);
    };
    try {
      await login();
      let dialog = page.getByRole("dialog", { name: "Настройка рабочего пространства" });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText("открой этот же сайт на своём Windows ПК");
      await dialog.getByLabel("Название компьютера").fill("Friend-PC");
      const download = page.waitForEvent("download");
      await dialog.getByRole("button", { name: "Подключить Windows ПК", exact: true }).click();
      await page
        .getByRole("dialog", { name: "Сохранить файл", exact: true })
        .getByRole("link", { name: "Скачать через браузер" })
        .click();
      assert.equal((await download).suggestedFilename(), "CodexWeb-Connect.zip");
      const enrollment = hub.enrollments.list(friend.id)[0];
      await page.reload();
      await expect(dialog).toBeVisible();
      const again = page.waitForEvent("download");
      await dialog.getByRole("button", { name: "Скачать установщик ещё раз", exact: true }).click();
      await page
        .getByRole("dialog", { name: "Сохранить файл", exact: true })
        .getByRole("link", { name: "Скачать через браузер" })
        .click();
      await again;
      await page.getByRole("button", { name: "Закрыть сохранение", exact: true }).click();
      assert.equal(hub.enrollments.list(friend.id).length, 1);
      assert.equal(hub.enrollments.list(friend.id)[0].id, enrollment.id);
      for (const [width, theme] of [
        [390, "crt-green"],
        [768, "hitech-2000s"],
      ]) {
        await page.setViewportSize({ width, height: 844 });
        await page.evaluate((value) => {
          document.documentElement.dataset.theme = value;
        }, theme);
        assert.equal(await dialog.evaluate((el) => el.scrollWidth > el.clientWidth + 1), false);
        await dialog.screenshot({ path: `.local/qa-onboarding/${engine}-${width}.png` });
      }
      await dialog.getByRole("button", { name: "2. ChatGPT", exact: true }).click();
      await dialog.getByRole("button", { name: "Подготовить мой ChatGPT", exact: true }).click();
      await expect(dialog).toContainText("Сервер готовит твой клиент");
      await dialog.getByRole("button", { name: "3. Готовность", exact: true }).click();
      await expect(
        dialog.getByRole("button", { name: "Начать работу", exact: true }),
      ).toBeDisabled();
      await dialog.getByRole("button", { name: "Позже", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      // Existing-page return from the installer opens the same saved setup.
      await page.goto(base + "/#setup");
      await expect(
        page.getByRole("dialog", { name: "Настройка рабочего пространства" }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Позже", exact: true }).click();
      await context.close();
      context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        serviceWorkers: "block",
      });
      page = await context.newPage();
      await login();
      await expect(
        page.getByRole("dialog", { name: "Настройка рабочего пространства" }),
      ).toHaveCount(0);
      // A same-site installer return resumes setup without a new identity or invite.
      await page.goto(base + "/#setup");
      await page.reload();
      dialog = page.getByRole("dialog", { name: "Настройка рабочего пространства" });
      await expect(dialog).toBeVisible();
      assert.equal(hub.enrollments.list(friend.id).length, 1);
      await dialog.getByRole("button", { name: "Позже", exact: true }).click();
      await context.close();
      context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        serviceWorkers: "block",
      });
      page = await context.newPage();
      await login("/#setup");
      await expect(
        page.getByRole("dialog", { name: "Настройка рабочего пространства" }),
      ).toBeVisible();
      hub.registry.db
        .prepare("UPDATE team_machine_enrollments SET expires=0 WHERE id=?")
        .run(enrollment.id);
      await page.reload();
      await expect(page.getByRole("dialog").getByLabel("Название компьютера")).toBeEnabled();
      await expect(
        page
          .getByRole("dialog")
          .getByRole("button", { name: "Подключить Windows ПК", exact: true }),
      ).toBeVisible();
      console.log(
        `${engine}: automatic member setup, same enrollment after reload, deferred cross-session resume and phone/tablet layout passed`,
      );
    } catch (error) {
      await page.screenshot({ path: `.local/qa-onboarding/${engine}-failure.png` });
      console.error(await page.locator("body").innerText());
      throw error;
    } finally {
      await context.close();
      await browser.close();
    }
  } finally {
    await hub.app.close();
    await rm(root, { recursive: true, force: true });
  }
}
