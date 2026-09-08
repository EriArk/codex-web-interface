import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, expect, webkit } from "@playwright/test";
import { handoffFixture } from "./handoff-fixture.mjs";

await mkdir(".local/qa-machines", { recursive: true });
for (const [engine, type] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
  let calls = 0,
    offline = false,
    now = Date.now();
  const diagnostics = {
    now: () => now,
    ssh: async () => {
      calls++;
      return offline ? "SSH_UNREACHABLE" : "SSH_OK";
    },
    codex: async () => ({ available: true, version: "codex-cli 0.153.4" }),
    remote: async () => true,
    resources: async () => ({
      memoryTotal: 16 * 1024 ** 3,
      memoryAvailable: 8 * 1024 ** 3,
      diskTotal: 1000 * 1024 ** 3,
      diskAvailable: 800 * 1024 ** 3,
      cpuPercent: 12,
      bootedAt: now - 3600000,
    }),
    rpc: () => ({
      initialize: async () => ({}),
      request: async (method) =>
        method === "account/read"
          ? { requiresOpenaiAuth: true, account: { type: "chatgpt" } }
          : { data: [{ id: "model" }] },
      close: () => {},
    }),
  };
  const origin = "http://127.0.0.1:18854",
    f = await handoffFixture(origin, undefined, { machineDiagnostics: diagnostics });
  f.sessions.config.machines[0].codex.launcher = "C:/fixed/companion.ps1";
  f.sessions.config.machines[0].remote = { host: "private", port: 5900, provider: "vnc" };
  f.store.db.prepare("UPDATE threads SET origin='web' WHERE id=?").run(f.thread.id);
  f.store.setPreferences({
    projectId: "project",
    threadId: f.thread.id,
    theme: "crt-green",
    view: "chat",
  });
  const browser = await type.launch(),
    context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      serviceWorkers: "block",
    });
  try {
    await f.app.listen({ port: 18854, host: "127.0.0.1" });
    const [name, value] = f.headers.cookie.split("=");
    await context.addCookies([{ name, value, url: origin, httpOnly: true, sameSite: "Strict" }]);
    const page = await context.newPage();
    await page.goto(origin);
    const editor = page.getByRole("textbox", { name: "Сообщение Codex" });
    await expect(editor).toBeVisible();
    await editor.fill("Сохранить мой черновик");
    const open = async () => {
      await page
        .getByRole("button", { name: "Настройки", exact: true })
        .filter({ visible: true })
        .first()
        .click();
      await page.getByRole("button", { name: "Компьютеры", exact: true }).click();
    };
    await open();
    const panel = page.getByRole("dialog", { name: "Компьютеры", exact: true });
    await expect(panel.getByRole("heading", { name: "PC", exact: true })).toBeVisible();
    assert.equal(calls, 0);
    await panel.getByRole("button", { name: "Проверить PC" }).tap();
    await expect(panel.getByText("Вход выполнен", { exact: true })).toBeVisible();
    assert.equal(calls, 1);
    await page.screenshot({ path: `.local/qa-machines/${engine}-phone.png` });
    await panel.getByRole("button", { name: "Закрыть компьютеры" }).tap();
    await expect(editor).toHaveValue("Сохранить мой черновик");
    await open();
    assert.equal(calls, 1);
    now += 16000;
    offline = true;
    await panel.getByRole("button", { name: "Проверить PC" }).tap();
    await expect(panel.getByText("Компьютер не отвечает по SSH", { exact: true })).toBeVisible();
    await expect(panel.locator(".machine-health-time")).toContainText("Был на связи");
    await page.setViewportSize({ width: 844, height: 390 });
    await page.screenshot({ path: `.local/qa-machines/${engine}-offline-landscape.png` });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await panel.getByRole("button", { name: "Закрыть компьютеры" }).click();
    await page.setViewportSize({ width: 1366, height: 1024 });
    await page
      .getByRole("button", { name: "Настройки", exact: true })
      .filter({ visible: true })
      .first()
      .click();
    await page.locator(".theme-option.hitech-2000s input").check();
    await page.getByRole("button", { name: "Компьютеры", exact: true }).click();
    await expect(panel).toBeVisible();
    await page.screenshot({ path: `.local/qa-machines/${engine}-tablet.png` });
    await panel.getByRole("button", { name: "Project", exact: true }).click();
    await expect(editor).toHaveValue("Сохранить мой черновик");
    await page
      .getByRole("combobox", { name: "Режим приложения" })
      .filter({ visible: true })
      .selectOption("gpt");
    const gptEditor = page.getByRole("textbox", { name: "Сообщение GPT" });
    await expect(gptEditor).toBeVisible();
    await gptEditor.fill("Черновик GPT");
    await open();
    await expect(panel.getByRole("heading", { name: "PC", exact: true })).toBeVisible();
    await panel.getByRole("button", { name: "Закрыть компьютеры", exact: true }).click();
    await expect(gptEditor).toHaveValue("Черновик GPT");
    await open();
    await panel.getByRole("button", { name: "Project", exact: true }).click();
    await expect(editor).toHaveValue("Сохранить мой черновик");
    f.sessions.config.projects.push({
      id: "second",
      name: "Second project",
      machineId: "pc",
      workingDirectory: "C:/Second",
      enabled: true,
    });
    const second = f.store.createThread("second", "native-second", "Second chat");
    f.store.append(
      second.id,
      "assistant.completed",
      { id: "second-answer", text: "Ответ другого проекта" },
      "second-turn",
    );
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    await page.route("**/api/projects/second/threads", async (route) => {
      await gate;
      await route.continue();
    });
    await open();
    await panel.getByRole("button", { name: "Second project", exact: true }).click();
    await expect(editor).not.toHaveValue("Сохранить мой черновик");
    release();
    await expect(page.getByText("Ответ другого проекта", { exact: true })).toBeVisible();
    await expect(
      page.getByText("Second project", { exact: true }).filter({ visible: true }).first(),
    ).toBeVisible();
    assert.equal(
      f.calls.filter((c) => ["thread/resume", "turn/start"].includes(c.method)).length,
      0,
    );
    assert.equal(f.desktopCalls.filter((c) => c !== "Status").length, 0);
    console.log(
      engine +
        ": cached diagnostics, explicit probe, offline/last-seen feedback, Codex/GPT entry points and project return preserve draft and native ownership",
    );
  } finally {
    await context.close();
    await browser.close();
    await f.close();
  }
}
