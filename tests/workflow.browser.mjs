import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { chromium, expect, webkit } from "@playwright/test";
import { handoffFixture } from "./handoff-fixture.mjs";

await mkdir(".local/qa-workflows", { recursive: true });
for (const [engine, type] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
  let applies = 0,
    finish;
  const gate = new Promise((resolve) => (finish = resolve));
  const origin = "http://127.0.0.1:18866",
    f = await handoffFixture(origin, undefined, {
      projectSetupProbe: async (_m, r) => {
        if (r.op === "repositories")
          return {
            login: "Owner",
            repositories: [
              {
                id: 1,
                owner: "Owner",
                name: "Existing",
                private: true,
                url: "https://github.com/Owner/Existing",
              },
            ],
            hasMore: false,
          };
        if (r.op === "inspect")
          return {
            exists: false,
            empty: true,
            git: false,
            branch: "",
            head: "",
            origin: "",
            dirty: false,
            fingerprint: "f".repeat(64),
            steps: [
              "create-directory",
              "git-init",
              "create-repository",
              "link-origin",
              "register-project",
            ],
          };
        if (r.op === "status") return null;
        applies++;
        await gate;
        return { id: r.id, state: "complete", phase: "register-project" };
      },
    });
  f.sessions.config.projects[0].workingDirectory = "C:\\Projects\\Project";
  f.store.setPreferences({
    projectId: "project",
    threadId: f.thread.id,
    view: "chat",
    theme: "crt-green",
  });
  const nativeRefresh = f.sessions.catalog.refresh.bind(f.sessions.catalog);
  f.sessions.catalog.createProject = async (_machine, name, path) => {
    const p = {
      id: "wizard-project",
      name,
      machineId: "pc",
      workingDirectory: path,
      enabled: true,
    };
    f.sessions.config.projects.push(p);
    return p;
  };
  const browser = await type.launch(),
    context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      serviceWorkers: "block",
    });
  try {
    await f.app.listen({ host: "127.0.0.1", port: 18866 });
    const [name, value] = f.headers.cookie.split("=");
    await context.addCookies([{ name, value, url: origin, httpOnly: true, sameSite: "Strict" }]);
    const page = await context.newPage(),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(origin);
    const editor = page.getByRole("textbox", { name: "Сообщение Codex" });
    await editor.fill("Сохранённый черновик");
    await page.getByRole("button", { name: "Открыть проекты", exact: true }).click();
    const drawer = page.getByRole("dialog", { name: "Проекты и диалоги" });
    await expect(drawer.getByRole("searchbox")).toBeVisible();
    assert.equal(await drawer.locator(".nav-brand").count(), 0);
    await expect(drawer.getByRole("button", { name: "Архив", exact: true })).toHaveCount(0);
    await expect(
      drawer
        .locator(".navigation-system-row")
        .getByRole("button", { name: "Переключиться на GPT" }),
    ).toBeVisible();
    await page.screenshot({
      animations: "disabled",
      path: `.local/qa-workflows/${engine}-drawer-phone.png`,
    });
    await drawer.getByRole("button", { name: "Создать проект", exact: true }).click();
    const wizard = page.getByRole("dialog", { name: "Создание проекта" });
    await wizard
      .getByRole("textbox", { name: "Название проекта", exact: true })
      .fill("Wizard Demo");
    await wizard.getByRole("button", { name: "Далее", exact: true }).click();
    await expect(wizard.getByRole("textbox", { name: "Папка проекта", exact: true })).toHaveValue(
      "C:\\Projects\\Wizard Demo",
    );
    await wizard.getByRole("button", { name: "Далее", exact: true }).click();
    await wizard.getByRole("button", { name: "Создать GitHub", exact: true }).click();
    await expect(wizard.getByText("Owner /", { exact: true })).toBeVisible();
    await wizard.getByRole("textbox", { name: "Название репозитория" }).fill("wizard-demo");
    await expect(wizard.getByRole("combobox", { name: "Видимость репозитория" })).toHaveValue(
      "private",
    );
    await wizard.getByRole("button", { name: "Проверить", exact: true }).click();
    await expect(wizard.getByRole("heading", { name: "Wizard Demo" })).toBeVisible();
    assert.equal(applies, 0);
    await page.screenshot({
      animations: "disabled",
      path: `.local/qa-workflows/${engine}-wizard-review-phone.png`,
    });
    await wizard.getByRole("button", { name: "Создать проект", exact: true }).click();
    await expect.poll(() => applies).toBe(1);
    await wizard.getByRole("button", { name: "Закрыть создание проекта" }).click();
    await expect(editor).toHaveValue("Сохранённый черновик");
    // Completion survives a closed dialog and a browser reload; opening it does not repeat setup.
    finish();
    await expect
      .poll(() => f.store.db.prepare("SELECT state FROM project_setup_operations").get()?.state)
      .toBe("complete");
    await page.reload();
    await page.getByRole("button", { name: "Открыть проекты", exact: true }).click();
    await drawer.getByRole("button", { name: "Создать проект", exact: true }).click();
    await expect(wizard.getByRole("button", { name: "Открыть проект" })).toBeVisible();
    assert.equal(applies, 1);
    await wizard.getByRole("button", { name: "Закрыть создание проекта" }).click();
    // Delayed existing GPT history must not display the new-chat composer or another chat's data.
    const a = randomUUID(),
      b = randomUUID(),
      catalog = [
        { id: a, title: "Первый разговор", updatedAt: 2 },
        { id: b, title: "Второй разговор", updatedAt: 1 },
      ];
    let pendingA,
      pendingB,
      failA = true,
      reads = 0;
    await page.route("**/api/gpt/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/gpt/status")
        return route.fulfill({ json: { configured: true, canSend: true, state: "healthy" } });
      if (path === "/api/gpt/models")
        return route.fulfill({
          json: {
            models: [{ id: "Latest", label: "Latest" }],
            efforts: [{ id: "2", label: "High" }],
            currentModel: "Latest",
            currentEffort: "2",
          },
        });
      if (path === "/api/gpt/projects")
        return route.fulfill({ json: { items: [], conversations: [] } });
      if (path === "/api/gpt/conversations")
        return route.fulfill({ json: { items: catalog, nextOffset: null } });
      if (path === `/api/gpt/conversations/${a}/messages`) {
        reads++;
        pendingA = route;
        return;
      }
      if (path === `/api/gpt/conversations/${b}/messages`) {
        pendingB = route;
        return;
      }
      return route.fulfill({ json: { items: [], stamp: Date.now() } });
    });
    await page.getByRole("button", { name: "Открыть проекты", exact: true }).click();
    await drawer.getByRole("button", { name: "Переключиться на GPT" }).click();
    await page.setViewportSize({ width: 1366, height: 1024 });
    const gpt = page.getByRole("textbox", { name: "Сообщение GPT" });
    await expect(gpt).toBeVisible();
    await page.getByRole("button", { name: "Первый разговор", exact: true }).click();
    const loading = page.getByRole("status", { name: "Состояние выбранного чата" });
    await expect(loading).toContainText("Первый разговор");
    await expect(gpt).not.toBeVisible();
    await expect(page.locator(".gpt-empty")).toHaveCount(0);
    await expect.poll(() => !!pendingA).toBe(true);
    await pendingA.fulfill({
      status: 503,
      json: { error: { code: "GPT_CONNECTION_LOST", message: "Temporary read failure" } },
    });
    pendingA = null;
    await expect(loading.getByRole("button", { name: "Повторить загрузку" })).toBeVisible();
    await loading.getByRole("button", { name: "Повторить загрузку" }).click();
    await expect.poll(() => reads).toBe(2);
    await page.getByRole("button", { name: "Второй разговор", exact: true }).click();
    await expect(loading).toContainText("Второй разговор");
    await expect.poll(() => !!pendingB).toBe(true);
    const history = (text) => ({
      items: [
        { id: randomUUID(), role: "assistant", text, createdAt: Date.now() / 1000, files: [] },
      ],
      nextBefore: null,
      revision: text,
      prefix: "",
      retainOlder: true,
      notModified: false,
    });
    await pendingA.fulfill({ json: history("Ответ только первого") });
    pendingA = null;
    await expect(loading).toContainText("Второй разговор");
    await pendingB.fulfill({ json: history("Ответ только второго") });
    pendingB = null;
    await expect(gpt).toBeVisible();
    await expect(page.getByText("Ответ только второго", { exact: true })).toBeVisible();
    await expect(page.getByText("Ответ только первого", { exact: true })).toHaveCount(0);
    await gpt.fill("Черновик GPT сохраняется");
    await page.getByRole("button", { name: "Первый разговор", exact: true }).click();
    await expect(page.getByText("Ответ только первого", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Второй разговор", exact: true }).click();
    await expect(gpt).toHaveValue("Черновик GPT сохраняется");
    for (const [index, theme] of [
      "organizer",
      "crt-green",
      "hitech-2000s",
      "classic-dark",
    ].entries()) {
      await page
        .getByRole("button", { name: "Настройки", exact: true })
        .filter({ visible: true })
        .first()
        .click();
      await page.locator(".gpt-themes button").nth(index).click();
      await page.getByRole("button", { name: "Закрыть настройки", exact: true }).click();
      await page.screenshot({
        animations: "disabled",
        path: `.local/qa-workflows/${engine}-gpt-${theme}.png`,
      });
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
    assert.deepEqual(errors, []);
    assert.equal(applies, 1);
    console.log(
      engine +
        ": compact navigation, persisted setup, selected GPT loading/failure/retry/races, drafts and themes passed",
    );
  } finally {
    finish();
    await context.close();
    await browser.close();
    await f.close();
  }
}
