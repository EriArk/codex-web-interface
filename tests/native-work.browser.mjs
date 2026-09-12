import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, expect, webkit } from "@playwright/test";
import { handoffFixture } from "./handoff-fixture.mjs";

for (const [engine, type] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
  const origin = "http://127.0.0.1:18925",
    f = await handoffFixture(origin);
  await f.release();
  await f.sessions.resume(f.thread.id);
  f.store.setPreferences({
    projectId: "project",
    threadId: f.thread.id,
    view: "chat",
    theme: "classic-dark",
    machineClients: { pc: "web" },
  });
  const r = await f.sessions.runtime("project");
  const emit = (method, p) =>
    r.rpc.emit("notification", method, { threadId: f.thread.codexThreadId, turnId: "turn", ...p });
  emit("turn/started", { turn: { id: "turn" } });
  emit("item/started", {
    item: { id: "cmd", type: "commandExecution", command: "pnpm test", status: "inProgress" },
  });
  emit("item/commandExecution/outputDelta", { itemId: "cmd", delta: "begin\n" });
  emit("turn/plan/updated", {
    plan: [
      { step: "Проверить работу интерфейса", status: "inProgress" },
      { step: "Собрать приложение", status: "pending" },
    ],
  });
  emit("thread/tokenUsage/updated", {
    tokenUsage: {
      last: { inputTokens: 1200, outputTokens: 100, cachedInputTokens: 1000, totalTokens: 1300 },
      modelContextWindow: null,
    },
  });
  emit("turn/diff/updated", { diff: "diff --git a/demo.ts b/demo.ts\n+Проверенное изменение" });
  const browser = await type.launch(),
    context = await browser.newContext({
      viewport: { width: 393, height: 852 },
      hasTouch: true,
      serviceWorkers: "block",
    });
  try {
    await f.app.listen({ port: 18925, host: "127.0.0.1" });
    const [name, value] = f.headers.cookie.split("=");
    await context.addCookies([{ name, value, url: origin, httpOnly: true }]);
    const page = await context.newPage(),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(origin);
    await page.getByRole("button", { name: "Ход работы", exact: true }).click();
    const details = page.locator("#turn-details");
    await expect(details).toContainText("Проверить работу интерфейса");
    const log = details.locator(".command-output");
    await log.locator("summary").click();
    await expect(log.locator("pre")).toHaveText("begin\n");
    emit("item/commandExecution/outputDelta", { itemId: "cmd", delta: "new line\n" });
    await expect(log.locator("pre")).toContainText("new line");
    // Native completion must update in place without collapsing the reader.
    emit("item/completed", {
      item: {
        id: "cmd",
        type: "commandExecution",
        command: "pnpm test",
        status: "completed",
        exitCode: 0,
        aggregatedOutput: "done\n",
      },
    });
    await expect(log.locator("pre")).toHaveText("done\n");
    await expect(log).toHaveAttribute("open", "");
    await log.getByRole("button", { name: "Скачать лог" }).click();
    const dialog = page.locator(".download-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).not.toContainText("Ссылка на файл недоступна");
    await page.keyboard.press("Escape");
    await mkdir(`.local/qa-native-work/${engine}`, { recursive: true });
    for (const theme of ["classic-dark", "organizer", "crt-green", "hitech-2000s"]) {
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
      }, theme);
      for (const width of [393, 1366]) {
        await page.setViewportSize({ width, height: width === 393 ? 852 : 1024 });
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await expect(page.locator(".context-usage")).toHaveCount(1);
        await page.screenshot({
          path: `.local/qa-native-work/${engine}/${theme}-${width}.png`,
          animations: "disabled",
        });
      }
    }
    assert.deepEqual(errors, []);
    console.log(
      engine +
        ": native live log, stable disclosure, downloadable text and four-theme phone/tablet checks passed",
    );
  } finally {
    await context.close();
    await browser.close();
    await f.close();
  }
}
