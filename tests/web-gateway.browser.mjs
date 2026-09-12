import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium, expect, webkit } from "@playwright/test";
import { atomicJson } from "../apps/hub/dist/web-releases.js";
import { gatewayFixture } from "./web-gateway-fixture.mjs";

await mkdir(".local/qa-deployments", { recursive: true });
for (const [engine, type] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
  const f = await gatewayFixture();
  f.store.db.prepare("UPDATE threads SET origin='web' WHERE id=?").run(f.thread.id);
  f.store.setPreferences({
    projectId: "project",
    threadId: f.thread.id,
    theme: "crt-green",
    view: "chat",
  });
  for (let i = 0; i < 20; i++)
    f.store.append(
      f.thread.id,
      "assistant.completed",
      {
        id: "history-" + i,
        phase: "final",
        text: "Ответ " + i + "\n\n" + "Сохранённая история проекта. ".repeat(20),
      },
      "old-" + i,
    );
  const browser = await type.launch(),
    context = await browser.newContext({
      viewport: { width: 393, height: 852 },
      hasTouch: true,
      serviceWorkers: "block",
    });
  try {
    const [name, value] = f.headers.cookie.split("=");
    await context.addCookies([{ name, value, url: f.origin, httpOnly: true, sameSite: "Strict" }]);
    const page = await context.newPage(),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(f.origin);
    const composer = page.getByRole("textbox", { name: "Сообщение Codex" });
    await composer.fill("Черновик переживает обновление");
    const scroll = page.locator(".chat-scroll");
    await expect.poll(() => scroll.evaluate((e) => e.scrollHeight > e.clientHeight)).toBe(true);
    await scroll.evaluate((e) => {
      e.scrollTop = Math.floor(e.scrollHeight / 3);
      e.dispatchEvent(new Event("scroll"));
    });
    await page.waitForTimeout(200);
    const before = await scroll.evaluate((e) => e.scrollTop);
    await f.stopEdge();
    await page.waitForTimeout(400);
    await f.startEdge();
    await page.waitForTimeout(1500);
    await expect(composer).toHaveValue("Черновик переживает обновление");
    assert(Math.abs((await scroll.evaluate((e) => e.scrollTop)) - before) < 4);
    assert.equal(f.rpc.closed, false);
    const terminal = await f.http("/api/devices/server/terminals", { kind: "shell" });
    assert.equal(terminal.status, 200);
    // The authenticated panel reads controller metadata, never a public status file.
    process.env.HUB_RELEASE_ROOT = f.releaseRoot;
    process.env.HUB_ROLE = "engine";
    atomicJson(join(f.releaseRoot, "maintenance.json"), {
      kind: "engine",
      revision: "abcdef456",
      state: "waiting",
      startedAt: Date.now() - 180000,
      updatedAt: Date.now(),
    });
    const deploymentResponse = await f.http("/api/deployment");
    assert.equal(deploymentResponse.status, 200, await deploymentResponse.clone().text());
    assert.equal((await deploymentResponse.json()).maintenance?.state, "waiting");
    await page
      .getByRole("button", { name: "Настройки", exact: true })
      .filter({ visible: true })
      .first()
      .click();
    await page.locator('.settings-browser[open] [data-category="maintenance"]').click();
    await page.locator(".deployment-status summary").click();
    await expect(
      page.getByText("Не удалось подтвердить, что терминал свободен", { exact: false }),
    ).toBeVisible();
    await expect(page.getByText("Ожидание: 3 мин.", { exact: true })).toBeVisible();
    for (const theme of ["crt-green", "hitech-2000s", "organizer", "classic-dark"]) {
      await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
      for (const width of [393, 1366]) {
        await page.setViewportSize({ width, height: width === 393 ? 852 : 1024 });
        await page.locator(".deployment-status").scrollIntoViewIfNeeded();
        assert(
          await page
            .locator(".deployment-status")
            .evaluate((e) => e.scrollWidth <= e.clientWidth + 2),
        );
        await page.screenshot({
          path: `.local/qa-deployments/${engine}-${theme}-${width}.png`,
          animations: "disabled",
        });
      }
    }
    assert.deepEqual(errors, []);
    console.log(
      engine +
        ": gateway reconnect preserves draft/scroll; authenticated release status and honest terminal blocker fit four themes at phone/tablet widths",
    );
  } finally {
    delete process.env.HUB_RELEASE_ROOT;
    delete process.env.HUB_ROLE;
    await context.close();
    await browser.close();
    await f.close();
  }
}
