import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, expect, webkit } from "@playwright/test";
import { HubError } from "../packages/shared/dist/index.js";
import { handoffFixture } from "./handoff-fixture.mjs";

await mkdir(".local/qa-project-setup", { recursive: true });
for (const [engine, type] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
  let available = false,
    applies = 0;
  const inspections = [],
    searches = [];
  const origin = "http://127.0.0.1:18867";
  const f = await handoffFixture(origin, undefined, {
    projectSetupProbe: async (_machine, request) => {
      if (request.op === "repositories") {
        searches.push(request.search);
        if (!available)
          throw new HubError(503, "SETUP_UNAVAILABLE", "Состояние операции сохранено.");
        return { login: "DifferentAccount", repositories: [], hasMore: false };
      }
      if (request.op === "inspect") {
        inspections.push(request.input);
        if (!available)
          throw new HubError(503, "SETUP_UNAVAILABLE", "Состояние операции сохранено.");
        return {
          exists: false,
          empty: true,
          git: false,
          branch: "",
          head: "",
          origin: "",
          dirty: false,
          remote: { owner: "neflores", name: "eligen", private: false },
          fingerprint: "a".repeat(64),
          steps: ["clone", "register-project"],
        };
      }
      if (request.op === "status") return null;
      applies++;
      return { id: request.id, state: "complete", phase: "register-project" };
    },
  });
  const browser = await type.launch();
  try {
    await f.app.listen({ host: "127.0.0.1", port: 18867 });
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      serviceWorkers: "block",
    });
    const [name, value] = f.headers.cookie.split("=");
    await context.addCookies([{ name, value, url: origin, httpOnly: true, sameSite: "Strict" }]);
    const page = await context.newPage(),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(origin);
    const editor = page.getByRole("textbox", { name: "Сообщение Codex" });
    await editor.fill("Parent draft retained");
    const open = async () => {
      await page.getByRole("button", { name: "Открыть проекты", exact: true }).click();
      await page
        .getByRole("dialog", { name: "Проекты и диалоги" })
        .getByRole("button", { name: "Создать проект", exact: true })
        .click();
    };
    await open();
    const wizard = page.getByRole("dialog", { name: "Создание проекта" });
    await wizard
      .getByLabel("Название проекта", { exact: true })
      .fill("A shared project with a long name");
    await wizard.getByRole("button", { name: "Далее", exact: true }).click();
    await wizard.getByRole("button", { name: "Далее", exact: true }).click();
    await wizard.getByRole("button", { name: "Подключить GitHub", exact: true }).click();
    await expect(wizard.getByRole("alert")).toContainText("Создание ещё не запускалось");
    await expect(wizard.getByRole("button", { name: "Проверить", exact: true })).toBeDisabled();
    const search = wizard.getByLabel("Найти репозиторий", { exact: true });
    for (const address of [
      "https://github.com/neflores/eligen",
      "git@github.com:neflores/eligen.git",
      "neflores/eligen",
    ]) {
      await search.fill(address);
      await wizard.getByRole("button", { name: "Поиск репозиториев", exact: true }).click();
      await expect(wizard.locator(".setup-review")).toContainText("neflores/eligen");
      await expect(wizard.getByRole("button", { name: "Проверить", exact: true })).toBeEnabled();
    }
    assert.deepEqual(searches, [""]);
    await wizard.getByRole("button", { name: "Проверить", exact: true }).click();
    await expect(wizard.getByRole("alert")).toContainText("Создание ещё не запускалось");
    assert.equal(applies, 0);
    assert.equal(f.store.db.prepare("SELECT count(*) n FROM project_setup_operations").get().n, 0);
    // Selection and parent draft survive closing; no mutation is retried in the background.
    await wizard.getByRole("button", { name: "Закрыть создание проекта" }).click();
    await expect(editor).toHaveValue("Parent draft retained");
    await open();
    await expect(wizard.locator(".setup-review")).toContainText("neflores/eligen");
    // A late catalog response cannot substitute a different account for an explicit repository.
    available = true;
    let pending;
    await page.route("**/api/machines/pc/github-repositories**", (route) => {
      pending = route;
    });
    await search.fill("another project");
    await expect(wizard.getByRole("button", { name: "Проверить", exact: true })).toBeDisabled();
    await wizard.getByRole("button", { name: "Поиск репозиториев", exact: true }).click();
    await expect.poll(() => !!pending).toBe(true);
    await search.fill("https://github.com/neflores/eligen.git");
    await wizard.getByRole("button", { name: "Поиск репозиториев", exact: true }).click();
    await pending
      .fulfill({ json: { login: "Other", repositories: [], hasMore: false } })
      .catch(() => {});
    await wizard.getByRole("button", { name: "Проверить", exact: true }).click();
    await expect(wizard.getByRole("button", { name: "Создать проект", exact: true })).toBeEnabled();
    assert.equal(inspections.at(-1).repository.owner, "neflores");
    assert.equal(inspections.at(-1).repository.name, "eligen");
    assert.equal(inspections.at(-1).repository.mode, "connect");
    await expect(wizard.locator(".setup-review")).toContainText("Публичный");
    assert.equal(applies, 0);
    for (const width of [390, 768, 1366]) {
      await page.setViewportSize({ width, height: 844 });
      for (const theme of ["organizer", "crt-green", "hitech-2000s", "classic-dark"]) {
        await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
        await page.screenshot({ path: `.local/qa-project-setup/${engine}-${width}-${theme}.png` });
        assert.equal(await wizard.evaluate((el) => el.scrollWidth > el.clientWidth + 1), false);
        await expect(
          wizard.getByRole("button", { name: "Закрыть создание проекта" }),
        ).toBeInViewport();
      }
    }
    assert.deepEqual(errors, []);
    await context.close();
    console.log(
      `${engine}: setup offline recovery, explicit repository selection, late-read isolation and themed layouts passed`,
    );
  } finally {
    await browser.close();
    await f.close();
  }
}
