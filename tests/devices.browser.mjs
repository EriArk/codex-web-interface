import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, expect, webkit } from "@playwright/test";
import { devicesFixture } from "./devices-fixture.mjs";

const origin = "http://127.0.0.1:18873";
for (const [engine, type] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
  const f = await devicesFixture(origin);
  f.store.setPreferences({
    projectId: "project",
    threadId: f.thread.id,
    theme: "classic-dark",
    machineClients: { pc: "web" },
  });
  f.store.append(
    f.thread.id,
    "activity.command",
    { itemId: "check", output: "All tests passed\n  exact spacing\n" },
    "turn",
  );
  f.store.result(f.thread.id, "turn", "check", "check", "Проверка завершена", {
    command: "pnpm test",
    exitCode: 0,
  });
  const browser = await type.launch(),
    context = await browser.newContext({
      viewport: { width: 1366, height: 1024 },
      hasTouch: true,
      serviceWorkers: "block",
    });
  const [name, value] = f.headers.cookie.split("=");
  await context.addCookies([{ name, value, url: origin, httpOnly: true, sameSite: "Strict" }]);
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const button = (name) =>
    page.getByRole("button", { name, exact: true }).filter({ visible: true }).first();
  const out = `.local/qa-devices/${engine}`;
  await mkdir(out, { recursive: true });
  try {
    await f.app.listen({ host: "127.0.0.1", port: 18873 });
    await page.goto(origin);
    const composer = page.getByRole("textbox", { name: "Сообщение Codex" });
    await composer.fill("Draft stays here");
    await composer.evaluate((e) => e.blur());
    let outputReads = 0;
    page.on("request", (r) => {
      if (r.url().endsWith("/output")) outputReads++;
    });
    assert.equal(outputReads, 0);
    const output = page.locator(".command-output").first();
    await expect(output).toBeVisible();
    assert.equal(await output.getAttribute("open"), null);
    await output.locator("summary").click();
    await expect(output.locator("pre")).toHaveText("All tests passed\n  exact spacing\n");
    assert.equal(outputReads, 1);
    await button("Открыть устройства").click();
    const modal = page.getByRole("dialog", { name: "Устройства", exact: true });
    await expect(modal).toBeVisible();
    await expect(modal.locator(".device-os")).toContainText("Ubuntu Linux");
    assert.equal(f.processes.length, 0);
    await button("Открыть терминал").click();
    await expect(modal.locator(".device-terminal-status")).toContainText("Подключено");
    assert.equal(f.processes.length, 1);
    await button("Открыть клавиатуру").click();
    await page.keyboard.type("test");
    await page.keyboard.press("Enter");
    await expect.poll(() => f.processes[0].writes.join("")).toContain("test\r");
    for (const theme of ["organizer", "crt-green", "hitech-2000s", "classic-dark"]) {
      await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${out}/tablet-${theme}.png` });
      assert.equal(await modal.evaluate((e) => e.scrollWidth > e.clientWidth + 1), false);
    }
    await button("Закрыть устройства").click();
    await expect(composer).toHaveValue("Draft stays here");
    assert(!f.processes[0].killed);
    await button("Открыть устройства").click();
    await expect(modal.locator(".device-terminal-status")).toContainText("Подключено");
    assert.equal(f.processes.length, 1);
    await modal.getByRole("button", { name: "ПК Windows" }).click();
    await expect(modal.locator(".device-os")).toContainText("Windows 10");
    await button("Открыть терминал").click();
    await expect.poll(() => f.processes.length).toBe(2);
    assert(f.processes[1].args.includes("powershell.exe"));
    await button("Перезагрузка").click();
    await expect(modal.locator(".device-action-dialog")).toContainText("Перезагрузить · ПК");
    await button("Отмена").click();
    assert.equal(f.processes.length, 2);
    await page.setViewportSize({ width: 393, height: 852 });
    await page.evaluate(() => window.dispatchEvent(new Event("resize")));
    await expect(modal.locator(".device-mobile-tabs")).toBeVisible();
    await button("Терминал").click();
    await expect(modal.locator(".device-system")).not.toBeVisible();
    await page.screenshot({ path: `${out}/phone-terminal.png` });
    await button("Система").click();
    await expect(modal.locator(".device-console")).not.toBeVisible();
    await page.screenshot({ path: `${out}/phone-system.png` });
    await button("Терминал").click();
    await page.setViewportSize({ width: 393, height: 430 });
    await page.evaluate(() => window.dispatchEvent(new Event("resize")));
    const keys = await modal.locator(".device-terminal-keys").boundingBox();
    assert(keys.y + keys.height <= 431);
    await page.screenshot({ path: `${out}/phone-keyboard.png` });
    assert.equal(
      f.calls.filter((c) => ["turn/start", "thread/start", "thread/resume"].includes(c.method))
        .length,
      0,
    );
    assert.equal(f.desktopCalls.length, 0);
    assert.deepEqual(errors, []);
    console.log(
      engine,
      "device selection, terminal input/reconnect, drafts, outputs, themes and phone passed",
    );
  } finally {
    await browser.close();
    await f.close();
  }
}
