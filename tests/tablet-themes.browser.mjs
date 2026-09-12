import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, expect, webkit } from "@playwright/test";
import { ProjectHome } from "../apps/hub/dist/overview.js";
import { handoffFixture } from "./handoff-fixture.mjs";

const origin = "http://127.0.0.1:18869";
function seed(f) {
  f.sessions.config.projects[0].name = "CodexWeb";
  f.store.db
    .prepare(
      "UPDATE threads SET origin='web',title='Планшетный интерфейс и рабочий цикл' WHERE id=?",
    )
    .run(f.thread.id);
  f.store.setPreferences({
    projectId: "project",
    threadId: f.thread.id,
    theme: "classic-dark",
    view: "chat",
    machineClients: { pc: "web" },
  });
  for (const [id, name] of [
    ["books", "Books — каталог и читалка"],
    ["trainer", "TrainerOS"],
    ["altar", "Altar Reborn"],
  ]) {
    f.sessions.config.projects.push({
      id,
      name,
      machineId: "pc",
      workingDirectory: "C:/" + id,
      enabled: true,
    });
    f.store.createThread(id, randomUUID(), "Разработка и проверка проекта");
  }
  f.store.createThread("project", randomUUID(), "Файловый менеджер, Git и результаты");
  for (let n = 0; n < 7; n++) {
    const turn = "audit-" + n;
    f.store.append(
      f.thread.id,
      "user.message",
      { id: "u" + n, text: "Проверь рабочий цикл проекта и удобство на планшете." },
      turn,
    );
    f.store.append(
      f.thread.id,
      "assistant.completed",
      {
        id: "a" + n,
        phase: "final_answer",
        text: 'Проверил навигацию и сохранение черновика.\n\n- Проекты и диалоги доступны в левой панели.\n- Результаты сохраняются отдельно от чата.\n- Переключение экранов не прерывает работу.\n\nМожно продолжить с того же места после возвращения на сайт.\n\n```typescript\nconst selectedProject = "CodexWeb";\n```',
      },
      turn,
    );
    f.store.append(f.thread.id, "turn.completed", { id: turn, status: "completed" }, turn);
    f.store.result(f.thread.id, turn, "check" + n, "check", "Проверка интерфейса " + (n + 1), {
      text: "Навигация, поворот экрана и сохранение состояния",
      exitCode: 0,
    });
  }
  const home = new ProjectHome(f.sessions),
    scope = { client: "codex", projectId: "project", name: "CodexWeb" };
  for (let n = 0; n < 5; n++) {
    home.notes.save(randomUUID(), {
      scope,
      title: [
        "Планшетный интерфейс",
        "Результаты проверки",
        "Идеи для следующего прохода",
        "Навигация проекта",
        "Настройки и горячие клавиши",
      ][n],
      body: "Заметка о работе с проектом.\n\nПроверить ширину панели, перенос длинного текста, расположение действий и сохранение черновика.",
      revision: 0,
      links: [],
    });
    home.tasks.save(randomUUID(), {
      scope,
      title: "Проверить планшетный сценарий " + (n + 1),
      body: "Чат, результаты и работа с клавиатурой.",
      revision: 0,
      links: [],
      status: n === 1 ? "doing" : "todo",
      priority: 2,
      dueAt: null,
    });
  }
}
for (const [engine, type] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
  const out = `.local/qa-tablet-themes/${engine}`;
  await mkdir(out, { recursive: true });
  const f = await handoffFixture(origin);
  seed(f);
  const browser = await type.launch();
  const context = await browser.newContext({
    viewport: { width: 1366, height: 1024 },
    hasTouch: true,
    serviceWorkers: "block",
  });
  const [name, value] = f.headers.cookie.split("=");
  await context.addCookies([{ name, value, url: origin, httpOnly: true, sameSite: "Strict" }]);
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = [],
    measurements = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const button = (name) =>
    page.getByRole("button", { name, exact: true }).filter({ visible: true }).first();
  const shot = async (name) => {
    await page.screenshot({ path: `${out}/${name}.png`, animations: "disabled" });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
      name + " root overflow",
    );
  };
  // Headless WebKit can batch viewport resize events. Deliver the same public event
  // deterministically; this verifies layout, not physical iOS keyboard behavior.
  const viewport = async (width, height) => {
    await page.setViewportSize({ width, height });
    await page.evaluate(() => window.dispatchEvent(new Event("resize")));
    await expect
      .poll(() =>
        page.evaluate(() =>
          parseFloat(document.documentElement.style.getPropertyValue("--app-height")),
        ),
      )
      .toBe(height);
  };
  const inViewport = async (locator) => {
    const box = await locator.boundingBox();
    assert.ok(
      box && box.y >= -1 && box.y + box.height <= page.viewportSize().height + 1,
      "control must remain in viewport",
    );
  };
  try {
    await f.app.listen({ port: 18869, host: "127.0.0.1" });
    await page.goto(origin);
    const composer = page.getByRole("textbox", { name: "Сообщение Codex" });
    await composer.fill("Черновик Codex: сохранить при смене оформления");
    await composer.evaluate((e) => e.blur());
    for (const [width, height] of [
      [1366, 1024],
      [1376, 1032],
      [1920, 1080],
      [2560, 1440],
    ]) {
      await viewport(width, height);
      const nav = await page.locator(".desktop-nav").boundingBox();
      const chat = await page.locator(".chat-pane").boundingBox();
      const results = await page.locator(".support-pane").boundingBox();
      const reading = await page.locator(".chat-content").boundingBox();
      assert(nav.width >= 280 && nav.width <= 337, "navigation scales within readable bounds");
      assert(
        chat.width > results.width && chat.width >= 700,
        "conversation has priority at 13-inch widths",
      );
      assert(reading.width <= 881, "desktop text retains a readable line length");
      measurements.push({
        width,
        height,
        nav: nav.width,
        chat: chat.width,
        results: results.width,
        reading: reading.width,
      });
      await shot(`workspace-${width}`);
      await button("Обзор текущего проекта").click();
      await expect(page.locator(".overview-main .overview-continue")).toBeVisible();
      const main = await page.locator(".overview-main").boundingBox();
      const context = await page.locator(".overview-context").boundingBox();
      assert(
        main.width > context.width && context.x > main.x,
        "overview has primary work and secondary context columns",
      );
      await shot(`overview-${width}`);
      await button("Закрыть обзор проекта").click();
      await expect(composer).toHaveValue("Черновик Codex: сохранить при смене оформления");
    }
    await viewport(1366, 1024);
    const pane = page.locator(".support-pane"),
      divider = page.locator(".pane-divider");
    let before = await pane.boundingBox(),
      handle = await divider.boundingBox();
    await page.mouse.move(handle.x + 3, handle.y + 150);
    await page.mouse.down();
    await page.mouse.move(handle.x + 4, handle.y + 150);
    await page.mouse.up();
    let after = await pane.boundingBox();
    assert.ok(
      Math.abs(before.width - after.width - 1) < 0.5,
      "one-pixel drag must not jump when sidebar is visible",
    );
    measurements.push({ test: "one-pixel drag", before: before.width, after: after.width });
    await page.waitForTimeout(120);
    // The extended hit area is usable without widening the visible separator.
    handle = await divider.boundingBox();
    before = await pane.boundingBox();
    await page.mouse.move(handle.x - 12, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x - 32, handle.y + handle.height / 2);
    await page.mouse.up();
    after = await pane.boundingBox();
    assert.ok(Math.abs(after.width - before.width - 20) < 2, "wide touch handle drag");
    await divider.focus();
    await page.keyboard.press("ArrowLeft");
    const storedWidth = await page.evaluate(() => localStorage.getItem("codex-right-width"));
    await button("Настройки").click();
    await page.locator('.settings-browser[open] [data-category="appearance"]').click();
    const settings = page.locator(".settings-dialog");
    const legacy = settings.getByRole("checkbox", { name: "Прежняя компоновка" });
    const refinedWidth = (await page.locator(".desktop-nav").boundingBox()).width;
    await legacy.check();
    assert.ok(
      (await page.locator(".desktop-nav").boundingBox()).width > refinedWidth,
      "previous layout restores navigation width",
    );
    await settings
      .locator(".settings-section:visible")
      .evaluate((e) => (e.scrollTop = e.scrollHeight));
    await inViewport(button("Закрыть настройки"));
    await shot("settings-sticky-close");
    await button("Закрыть настройки").click();
    await page.reload();
    await expect(composer).toHaveValue("Черновик Codex: сохранить при смене оформления");
    await expect(page.locator("html")).toHaveAttribute("data-layout", "legacy");
    assert.equal(await page.evaluate(() => localStorage.getItem("codex-right-width")), storedWidth);
    await button("Настройки").click();
    await page.locator('.settings-browser[open] [data-category="appearance"]').click();
    await legacy.uncheck();
    await button("Закрыть настройки").click();
    for (const theme of ["classic-dark", "organizer", "hitech-2000s", "crt-green"]) {
      await button("Настройки").click();
      await page.locator('.settings-browser[open] [data-category="appearance"]').click();
      await settings.locator(`.theme-option.${theme} input`).check();
      await button("Закрыть настройки").click();
      await viewport(1366, 1024);
      await shot(`workspace-${theme}`);
      if (theme === "crt-green")
        assert.equal(
          await page.locator(".workspace").evaluate((e) => getComputedStyle(e).borderLeftWidth),
          "1px",
          "CRT retains the owner's continuous compact polymer seam",
        );
      await button("Заметки").click();
      const notes = page.locator(".notebook-dialog");
      await notes.locator(".notebook-row button").last().click();
      const contextAction = notes.locator(".notebook-context").first();
      assert.equal(
        await contextAction.evaluate((e) => e.scrollWidth > e.clientWidth),
        false,
        "source caption must not overflow",
      );
      await shot(`notes-${theme}`);
      await button("Закрыть заметки").click();
      await button("Планы").click();
      const plans = page.getByRole("dialog", { name: "Планы", exact: true });
      await plans.getByRole("button", { name: "Новый план", exact: true }).click();
      await plans
        .getByRole("textbox", { name: "Название плана", exact: true })
        .fill("Планшетный рабочий цикл");
      await plans
        .getByRole("textbox", { name: "Описание плана", exact: true })
        .fill("Проверить интерфейс и сохранить ход работы.");
      await shot(`plan-${theme}`);
      await button("Закрыть рабочий раздел").click();
      await button("Обзор текущего проекта").click();
      await shot(`overview-${theme}`);
      await button("Закрыть обзор проекта").click();
      await viewport(393, 852);
      await shot(`phone-${theme}`);
      await expect(composer).toHaveValue("Черновик Codex: сохранить при смене оформления");
      await viewport(1366, 1024);
    }
    await button("Заметки").click();
    await page.locator(".notebook-dialog .notebook-row button").last().click();
    for (const [width, height] of [
      [1024, 1366],
      [820, 1180],
      [744, 1024],
    ]) {
      await viewport(width, height);
      await shot(`notes-${width}`);
    }
    const noteBody = page.getByRole("textbox", { name: "Текст заметки" });
    await noteBody.fill("Несохранённая заметка: поворот и клавиатура");
    await viewport(744, 480);
    await expect(page.locator("html")).toHaveAttribute("data-keyboard", "true");
    await inViewport(button("Закрыть заметки"));
    await shot("notes-keyboard");
    await viewport(1366, 1024);
    await expect(noteBody).toHaveValue("Несохранённая заметка: поворот и клавиатура");
    await button("Закрыть заметки").click();
    await viewport(1180, 820);
    await composer.focus();
    await viewport(1180, 410);
    await inViewport(composer);
    await shot("codex-keyboard");
    await viewport(1366, 1024);
    await page.route("**/api/gpt/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      let data = { items: [], conversations: [], nextOffset: null };
      if (path.endsWith("/status"))
        data = { configured: true, canSend: true, state: "healthy", activeJobs: 0, unknownJobs: 0 };
      else if (path.endsWith("/models"))
        data = {
          models: [{ id: "Latest", label: "Latest" }],
          efforts: [{ id: "2", label: "High" }],
          currentModel: "Latest",
          currentEffort: "2",
        };
      else if (path.endsWith("/jobs"))
        data = {
          items: [
            {
              id: "old-summary",
              nativeId: "tablet-gpt",
              summaryOnly: true,
              status: "failed",
              text: "",
              files: [],
              answer: "",
              assets: [],
              error: "",
              createdAt: 1,
              updatedAt: 2,
            },
          ],
          stamp: 1,
        };
      else if (path.endsWith("/conversations"))
        data = {
          items: [{ id: "tablet-gpt", title: "Планшетный интерфейс GPT", updatedAt: 100 }],
          nextOffset: null,
        };
      else if (path.endsWith("/messages"))
        data = {
          items: [
            {
              id: "g-u",
              role: "user",
              text: "Проверь планшетный интерфейс",
              files: [],
              createdAt: 1,
            },
            {
              id: "g-a",
              role: "assistant",
              text: "Рабочее пространство сохраняет черновики и выбранный диалог.\n\nПанели прокручиваются независимо.",
              files: [],
              createdAt: 2,
            },
          ],
          nextBefore: null,
          revision: "1",
          prefix: "1",
        };
      await route.fulfill({ json: data });
    });
    await button("Переключиться на GPT").click();
    await button("Планшетный интерфейс GPT").click();
    const gptComposer = page.getByRole("textbox", { name: "Сообщение GPT" });
    await expect(page.locator(".gpt-job")).toHaveCount(0);
    await gptComposer.fill("Черновик GPT: сохранить настройки");
    for (const theme of ["classic-dark", "organizer", "hitech-2000s", "crt-green"]) {
      await button("Настройки").click();
      await page.locator('.settings-browser[open] [data-category="appearance"]').click();
      const gptSettings = page.locator(".gpt-settings");
      await gptSettings.locator(`.theme-option.${theme} input`).check();
      await gptSettings
        .locator(".settings-section:visible")
        .evaluate((e) => (e.scrollTop = e.scrollHeight));
      await inViewport(button("Закрыть настройки"));
      await button("Закрыть настройки").click();
      await shot(`gpt-${theme}`);
      await viewport(393, 852);
      await shot(`gpt-phone-${theme}`);
      await viewport(1366, 1024);
    }
    await button("Настройки").click();
    await page.locator('.settings-browser[open] [data-category="appearance"]').click();
    await page
      .locator(".gpt-settings")
      .getByRole("checkbox", { name: "Прежняя компоновка" })
      .check();
    await button("Закрыть настройки").click();
    await button("Переключиться на Codex").click();
    await expect(composer).toHaveValue("Черновик Codex: сохранить при смене оформления");
    await expect(page.locator("html")).toHaveAttribute("data-layout", "legacy");
    assert.deepEqual(errors, []);
    assert.equal(
      f.calls.filter((c) => ["turn/start", "turn/steer", "turn/interrupt"].includes(c.method))
        .length,
      0,
      "appearance must not mutate native work",
    );
    await writeFile(
      `${out}/checks.json`,
      JSON.stringify({ engine, measurements, errors }, null, 2),
    );
    console.log(
      `${engine}: tablet themes, divider, legacy preference, sticky close, drafts and keyboard layout passed`,
    );
  } finally {
    await context.close();
    await browser.close();
    await f.close();
  }
}
