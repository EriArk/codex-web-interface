import assert from "node:assert/strict";
import { chromium, expect, webkit } from "@playwright/test";
import { nativeWorkspaceFixture } from "./fixtures/native-workspace.mjs";
import { handoffFixture } from "./handoff-fixture.mjs";

for (const [engine, type] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
  const native = nativeWorkspaceFixture(),
    origin = "http://127.0.0.1:18941";
  const f = await handoffFixture(origin, undefined, { nativeGpt: native.workspace });
  const browser = await type.launch(),
    context = await browser.newContext({
      viewport: { width: 393, height: 852 },
      hasTouch: true,
      serviceWorkers: "block",
    });
  try {
    await f.app.listen({ port: 18941, host: "127.0.0.1" });
    const [name, value] = f.headers.cookie.split("=");
    await context.addCookies([{ name, value, url: origin, httpOnly: true }]);
    await context.addInitScript((id) => {
      localStorage.setItem("codex-client", "gpt");
      localStorage.setItem("gpt-conversation", id);
    }, native.conversationId);
    const page = await context.newPage(),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(origin);
    const composer = page.getByRole("textbox", { name: "Сообщение GPT" });
    await expect(composer).toBeVisible();
    await expect(page.getByText("Первый ответ", { exact: true })).toBeVisible();
    await page.getByLabel("Модель GPT", { exact: true }).selectOption("fast");
    await expect(page.getByLabel("Мощность GPT", { exact: true })).toHaveValue("0");
    assert.deepEqual(
      await page.getByLabel("Мощность GPT", { exact: true }).locator("option").allTextContents(),
      ["Instant"],
    );
    await page.getByLabel("Модель GPT", { exact: true }).selectOption("latest");
    await expect(page.getByLabel("Мощность GPT", { exact: true })).toHaveValue("1");
    native.state.loseAck = true;
    await composer.fill(native.input.text);
    await page.getByRole("button", { name: "Отправить GPT", exact: true }).click();
    await expect.poll(() => native.state.sends).toBe(1);
    await expect
      .poll(() => f.store.db.prepare("SELECT answer FROM gpt_jobs LIMIT 1").get()?.answer)
      .toBe("Проверяю вложение");
    native.state.finished = true;
    await expect
      .poll(() => f.store.db.prepare("SELECT status FROM gpt_jobs LIMIT 1").get()?.status, {
        timeout: 12000,
      })
      .toBe("completed");
    await expect(page.getByText("nativeworkspaceok", { exact: false }).first()).toBeVisible({
      timeout: 12000,
    });
    await page.reload();
    await expect(page.getByText("nativeworkspaceok", { exact: false }).first()).toBeVisible();
    assert.equal(native.state.sends, 1);
    assert.deepEqual(errors, []);
    console.log(
      engine +
        ": shared GPT UI/native service, per-model presets, lost ack, public output and reload passed",
    );
  } finally {
    await context.close();
    await browser.close();
    await f.close();
  }
}
