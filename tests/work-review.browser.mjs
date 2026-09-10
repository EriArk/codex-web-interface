import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { chromium, expect, webkit } from "@playwright/test";
import { handoffFixture } from "./handoff-fixture.mjs";

const scope = { client: "codex", projectId: "project", name: "Project" };
for (const [engine, type] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
  const origin = "http://127.0.0.1:18875",
    f = await handoffFixture(origin);
  await f.release();
  const request = async (method, url, payload) => {
    const r = await f.app.inject({ method, url, payload, headers: f.headers });
    assert.equal(r.statusCode, 200, r.body);
    return r.json();
  };
  const planId = randomUUID(),
    id = randomUUID();
  const complete = async () => {
    await request("PUT", "/api/workspace/plans/" + planId, {
      scope,
      title: "Мобильная навигация",
      description: "Сохранить удобство",
      sections: [
        {
          id: randomUUID(),
          title: "Интерфейс",
          items: [{ id: randomUUID(), text: "Исправить меню", checked: false }],
        },
      ],
      links: [],
      revision: 0,
    });
    await request("PUT", "/api/workspace/actions/" + id, {
      scope,
      kind: "plan",
      planId,
      planRevision: 1,
    });
    const sent = await request("POST", `/api/workspace/actions/${id}/submit`, { confirm: true });
    f.store.result(f.thread.id, sent.turnId, "check-review", "check", "Проверка навигации", {
      command: "pnpm test",
      exitCode: 0,
    });
    f.store.append(
      f.thread.id,
      "assistant.completed",
      {
        id: "review-final",
        text: "## Меню готово\n\nИсправлены жесты и сохранение черновиков. На физическом iPad проверить не удалось.\n\n```txt\nexact copy\n```",
        phase: "final",
      },
      sent.turnId,
    );
    f.finishTurn();
    await request("GET", "/api/workspace/reviews");
  };
  f.store.setPreferences({ projectId: "project", threadId: f.thread.id, theme: "classic-dark" });
  const browser = await type.launch(),
    context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      serviceWorkers: "block",
    });
  const [name, value] = f.headers.cookie.split("=");
  await context.addCookies([{ name, value, url: origin, httpOnly: true, sameSite: "Strict" }]);
  const page = await context.newPage(),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const out = `.local/qa-review/${engine}`;
  await mkdir(out, { recursive: true });
  try {
    await f.app.listen({ host: "127.0.0.1", port: 18875 });
    await page.goto(origin);
    const chat = page.getByRole("textbox", { name: "Сообщение Codex" });
    await chat.fill("Несвязанный черновик");
    await complete();
    await page.getByRole("button", { name: "Проверить работу", exact: true }).first().click();
    const panel = page.getByRole("dialog", { name: "Приёмка работы", exact: true });
    await expect(panel.getByRole("heading", { name: "Меню готово" })).toBeVisible();
    await panel.getByRole("button", { name: "Нужны исправления", exact: true }).click();
    await panel.getByRole("textbox", { name: "Что исправить" }).fill("Кнопку ещё ниже");
    await panel.getByRole("button", { name: "Закрыть приёмку" }).click();
    await expect(chat).toHaveValue("Несвязанный черновик");
    await page.getByRole("button", { name: "Проверить работу", exact: true }).first().click();
    await panel.getByRole("button", { name: "Нужны исправления", exact: true }).click();
    await expect(panel.getByRole("textbox", { name: "Что исправить" })).toHaveValue(
      "Кнопку ещё ниже",
    );
    await panel.getByRole("button", { name: "Сохранить замечание" }).click();
    await expect(panel.locator(".review-owner-note")).toHaveText("Кнопку ещё ниже");
    assert.equal(f.calls.filter((c) => c.method === "turn/start").length, 1);
    await panel.getByRole("button", { name: "Подготовить исправление" }).click();
    await expect(panel.getByRole("button", { name: "Подтвердить и запустить" })).toBeVisible();
    assert.equal(f.calls.filter((c) => c.method === "turn/start").length, 1);
    await panel.getByRole("button", { name: "Отмена", exact: true }).click();
    let lost = false;
    await page.route("**/api/workspace/reviews/*/decision", async (route) => {
      if (!lost && route.request().postDataJSON()?.decision === "accepted") {
        lost = true;
        await route.fetch();
        await route.abort("failed");
      } else await route.continue();
    });
    await panel.getByRole("button", { name: "Принять работу", exact: true }).click();
    await expect(panel.getByRole("alert")).toBeVisible();
    await panel.getByRole("button", { name: "Принять работу", exact: true }).click();
    await expect(panel.locator(".review-state")).toHaveText("Работа принята");
    assert.equal((await request("GET", `/api/workspace/reviews/${id}`)).review.revision, 3);
    for (const theme of ["classic-dark", "organizer", "crt-green", "hitech-2000s"]) {
      await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
      for (const width of [390, 1366]) {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 1024 });
        await expect(panel).toBeVisible();
        assert(await panel.evaluate((el) => el.scrollWidth <= el.clientWidth));
        await page.screenshot({ path: `${out}/${theme}-${width}.png` });
      }
    }
    await page.setViewportSize({ width: 390, height: 440 });
    await panel.getByRole("button", { name: "Нужны исправления", exact: true }).click();
    await expect(panel.getByRole("textbox", { name: "Что исправить" })).toBeVisible();
    await page.screenshot({ path: `${out}/keyboard.png` });
    await panel.getByRole("button", { name: "Закрыть приёмку" }).click();
    await expect(chat).toHaveValue("Несвязанный черновик");
    assert.deepEqual(errors, []);
    console.log(
      engine +
        ": exact review, correction draft, lost acknowledgement, four themes and keyboard passed",
    );
  } catch (e) {
    await page.screenshot({ path: `${out}/failure.png` });
    console.error((await page.locator("body").innerText()).slice(-12000));
    console.error(errors);
    throw e;
  } finally {
    await context.close();
    await browser.close();
    await f.close();
  }
}
