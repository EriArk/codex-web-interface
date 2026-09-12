import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, expect, webkit } from "@playwright/test";
import { handoffFixture } from "./handoff-fixture.mjs";

const origin = "http://127.0.0.1:18896";
for (const [engine, type] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
  const out = `.local/qa-polymer/${engine}`;
  await mkdir(out, { recursive: true });
  const f = await handoffFixture(origin);
  f.sessions.config.projects[0].name = "CodexWeb";
  f.store.db
    .prepare("UPDATE threads SET origin='web', title='Дизайн и рабочий цикл' WHERE id=?")
    .run(f.thread.id);
  f.store.setPreferences({
    projectId: "project",
    threadId: f.thread.id,
    theme: "hitech-2000s",
    view: "chat",
    machineClients: { pc: "web" },
  });
  f.store.append(
    f.thread.id,
    "assistant.completed",
    {
      id: "answer",
      phase: "final_answer",
      text: "## Проект готов к работе\n\nСохранил изменения и проверил интерфейс. Можно продолжить с того же места.\n\n| Раздел | Для чего |\n| --- | --- |\n| Заметки | Идеи и полезные ответы. |\n| Основа проекта | Постоянные требования и предпочтения. |",
    },
    "turn",
  );
  f.store.result(f.thread.id, "turn", "check", "check", "Проверка завершена", {
    text: "Файлы, навигация и сохранение черновика",
    exitCode: 0,
  });
  f.store.append(f.thread.id, "turn.completed", { id: "turn", status: "completed" }, "turn");
  const browser = await type.launch();
  const context = await browser.newContext({
    viewport: { width: 393, height: 852 },
    hasTouch: true,
    serviceWorkers: "block",
  });
  const [name, value] = f.headers.cookie.split("=");
  const cookie = { name, value, url: origin, httpOnly: true, sameSite: "Strict" };
  await context.addCookies([cookie]);
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const button = (name) =>
    page.getByRole("button", { name, exact: true }).filter({ visible: true }).first();
  const resize = async (width, height) => {
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
  const shot = async (name) => {
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: `${out}/${name}.png`, animations: "disabled" });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), name);
  };
  try {
    await f.app.listen({ port: 18896, host: "127.0.0.1" });
    const invalid = await f.app.inject({
      method: "PATCH",
      url: "/api/preferences",
      headers: f.headers,
      payload: { crtCaseColor: "url(https://example.test)" },
    });
    assert.equal(invalid.statusCode, 400);
    await page.goto(origin);
    const composer = page.getByRole("textbox", { name: "Сообщение Codex" });
    await composer.fill("Черновик остаётся при смене оформления");
    await composer.blur();
    for (const theme of ["hitech-2000s", "crt-green"]) {
      await button("Настройки").click();
      await page.locator(`.settings-dialog .theme-option.${theme} input`).check();
      for (const [label, id] of [
        ["Чёрный", "graphite"],
        ["Белый", "white"],
        ["Жёлтый", "yellow"],
        ["Мятный", "mint"],
        ["Фиолетовый", "purple"],
        ["Розовый", "pink"],
        ["Красный", "red"],
        ["Оранжевый", "orange"],
        ["Серебристый", "silver"],
        ["Синий", "blue"],
        ["Зелёный", "green"],
        ["Бирюзовый", "turquoise"],
      ]) {
        await button(label).click();
        await expect(button(label)).toBeEnabled();
        await expect(page.locator("html")).toHaveAttribute("data-case-color", id);
        assert.equal(
          f.store.preferences()[theme === "crt-green" ? "crtCaseColor" : "hitechCaseColor"],
          id,
        );
      }
      if (theme === "crt-green") {
        await button("Зелёный").click();
        await expect(button("Зелёный")).toBeEnabled();
      }
      await shot(`${theme}-settings-phone`);
      await button("Закрыть настройки").click();
      await expect(composer).toHaveValue("Черновик остаётся при смене оформления");
      for (const [width, height] of [
        [393, 852],
        [320, 740],
        [844, 390],
        [1366, 1024],
      ]) {
        await resize(width, height);
        await shot(`${theme}-chat-${width}`);
        if (width < 1100) await button("Открыть проекты").click();
        const toggle = button("Переключиться на GPT");
        const box = await toggle.boundingBox();
        assert(
          box && box.width >= 54 && box.height >= 54 && box.y >= 0 && box.y + box.height <= height,
        );
        assert.notEqual(
          await toggle.evaluate((el) => getComputedStyle(el, "::before").content),
          "none",
        );
        await shot(`${theme}-navigation-${width}`);
        if (width < 1100) await button("Закрыть проекты").click();
      }
      await resize(393, 852);
    }
    // A failed preference write rolls back the preview and stays explicitly retryable.
    await button("Настройки").click();
    await page.route("**/api/preferences", (route) =>
      route.request().method() === "PATCH"
        ? route.fulfill({ status: 503, json: { code: "TEST_UNAVAILABLE", message: "Unavailable" } })
        : route.continue(),
    );
    await button("Красный").click();
    await expect(page.locator(".case-color-error")).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-case-color", "green");
    await page.unroute("**/api/preferences");
    await button("Красный").click();
    await expect(button("Красный")).toBeEnabled();
    await expect(page.locator(".case-color-error")).toHaveCount(0);
    await button("Закрыть настройки").click();
    await page.reload();
    await expect(composer).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-case-color", "red");
    // A fresh device restores both independent casing preferences from Hub metadata.
    const second = await browser.newContext({
      viewport: { width: 393, height: 852 },
      serviceWorkers: "block",
    });
    try {
      await second.addCookies([cookie]);
      const other = await second.newPage();
      await other.goto(origin);
      await expect(other.locator("html")).toHaveAttribute("data-case-color", "red");
      await other
        .getByRole("button", { name: "Настройки", exact: true })
        .filter({ visible: true })
        .first()
        .click();
      await other.locator(".settings-dialog .theme-option.hitech-2000s input").check();
      await expect(other.locator("html")).toHaveAttribute("data-case-color", "turquoise");
    } finally {
      await second.close();
    }
    await page.route("**/api/gpt/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      let data = { items: [], conversations: [], nextOffset: null };
      if (path.endsWith("/status"))
        data = {
          configured: true,
          connected: true,
          authenticated: true,
          locked: false,
          busy: false,
          canSend: true,
        };
      else if (path.endsWith("/models"))
        data = {
          models: [{ id: "Latest", label: "Latest" }],
          efforts: [{ id: "2", label: "High" }],
          currentModel: "Latest",
          currentEffort: "2",
        };
      else if (path.endsWith("/projects")) data = { items: [], conversations: [] };
      else if (path.endsWith("/jobs")) data = { items: [], stamp: 1 };
      else if (path.endsWith("/conversations"))
        data = {
          items: [{ id: "polymer-gpt", title: "Дизайн и материалы", updatedAt: 100 }],
          nextOffset: null,
        };
      else if (path.endsWith("/messages"))
        data = {
          items: [
            {
              id: "g-a",
              role: "assistant",
              text: "Новый корпус, прежний рабочий процесс.\n\nТекст остаётся на светлом утопленном экране.",
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
    await button("Открыть проекты").click();
    await button("Переключиться на GPT").click();
    if (!(await button("Дизайн и материалы").isVisible())) await button("Открыть проекты").click();
    await button("Дизайн и материалы").click();
    await expect(page.locator(".project-sheet[open]")).toHaveCount(0);
    await expect(page.locator(".gpt-chat .message-body").first()).toContainText(
      "Новый корпус, прежний рабочий процесс.",
    );
    const gpt = page.getByRole("textbox", { name: "Сообщение GPT" });
    await gpt.fill("Черновик GPT тоже остаётся");
    await gpt.blur();
    await expect(gpt).toHaveValue("Черновик GPT тоже остаётся");
    await button("Настройки").click();
    assert.equal(
      await page.evaluate(
        () => JSON.parse(sessionStorage.getItem("gpt-draft-polymer-gpt") ?? "{}").text,
      ),
      "Черновик GPT тоже остаётся",
      "Saved GPT draft before appearance change",
    );
    await page.locator(".gpt-settings .theme-option.hitech-2000s input").check();
    assert.equal(
      await page.evaluate(
        () => JSON.parse(sessionStorage.getItem("gpt-draft-polymer-gpt") ?? "{}").text,
      ),
      "Черновик GPT тоже остаётся",
      "Saved GPT draft after theme change",
    );
    await expect(page.locator("html")).toHaveAttribute("data-case-color", "turquoise");
    await button("Синий").click();
    await expect(button("Синий")).toBeEnabled();
    assert.equal(
      await page.evaluate(
        () => JSON.parse(sessionStorage.getItem("gpt-draft-polymer-gpt") ?? "{}").text,
      ),
      "Черновик GPT тоже остаётся",
      "Saved GPT draft after color change",
    );
    await button("Закрыть настройки").click();
    await expect(gpt).toHaveValue("Черновик GPT тоже остаётся");
    await shot("hitech-gpt-phone-blue");
    await resize(1366, 1024);
    await shot("hitech-gpt-tablet-blue");
    assert.deepEqual(errors, []);
    assert.equal(
      f.calls.filter((c) => ["turn/start", "turn/steer", "turn/interrupt"].includes(c.method))
        .length,
      0,
    );
    assert.deepEqual(
      f.desktopCalls.filter((action) => action !== "Status"),
      [],
      "Appearance must not control the desktop",
    );
    assert.equal(f.store.preferences().projectId, "project");
    assert.equal(f.store.preferences().threadId, f.thread.id);
    console.log(
      `${engine}: twelve case colors, independent Hub persistence, fresh device, failed save recovery, Codex/GPT drafts, phone/landscape/tablet and physical toggle passed`,
    );
  } catch (error) {
    await page.screenshot({ path: `${out}/failure.png` });
    console.log({ errors, fixtureScreen: (await page.locator("body").innerText()).slice(0, 2200) });
    throw error;
  } finally {
    await context.close();
    await browser.close();
    await f.close();
  }
}
