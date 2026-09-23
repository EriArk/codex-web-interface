import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect, webkit } from "@playwright/test";
import { nativeWorkspaceFixture } from "./fixtures/native-workspace.mjs";
import { handoffFixture } from "./handoff-fixture.mjs";

const root = await mkdtemp(join(tmpdir(), "cw-project-gpt-ui-"));
execFileSync("git", ["init", "-q", root]);
const native = nativeWorkspaceFixture(),
  origin = "http://127.0.0.1:18947";
// Canonical timestamps must match the durable send, as they do in native history.
let dispatchedAt = 0;
const dispatch = native.client.dispatchText,
  graph = native.client.conversationGraph;
native.client.dispatchText = async (input) => {
  dispatchedAt = Math.floor(Date.now() / 1000);
  return dispatch(input);
};
native.client.conversationGraph = async (id) => {
  const result = await graph(id);
  for (const node of Object.values(result.mapping))
    if (node.message && node.id !== result.mapping[Object.keys(result.mapping)[0]].id)
      node.message.create_time = dispatchedAt;
  return result;
};
const f = await handoffFixture(origin, undefined, {
  nativeGpt: native.workspace,
  configure: (cfg) => {
    cfg.machines[0] = { ...cfg.machines[0], type: "local-linux", allowedRoots: [root] };
    cfg.projects[0].workingDirectory = root;
  },
});
const browser = await (process.env.BROWSER === "chromium" ? chromium : webkit).launch(),
  context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    serviceWorkers: "block",
  });
await f.app.listen({ port: 18947, host: "127.0.0.1" });
const [cookieName, cookieValue] = f.headers.cookie.split("=");
await context.addCookies([{ name: cookieName, value: cookieValue, url: origin, httpOnly: true }]);
await context.addInitScript((thread) => {
  localStorage.setItem("codex-project", "project");
  localStorage.setItem("codex-thread", thread);
  localStorage.setItem("gpt-conversation", "ordinary-chat-selection");
}, f.thread.id);
const page = await context.newPage(),
  errors = [];
page.setDefaultTimeout(15000);
page.on("pageerror", (e) => errors.push(e.message));
const popup = page.locator(".project-gpt-window");
async function open() {
  await page.getByRole("button", { name: "Обзор текущего проекта", exact: true }).click();
  await page
    .locator(".project-overview-modal")
    .getByRole("button", { name: /GPT проекта Личный чат/ })
    .click();
  await expect(popup.getByRole("textbox", { name: "Сообщение GPT", exact: true })).toBeVisible();
}
try {
  await page.goto(origin);
  await open();
  await popup.getByLabel("Настройки GPT проекта", { exact: true }).click();
  await expect(popup.getByLabel("Чат GPT проекта").locator("option")).toHaveCount(2);
  await popup.getByLabel("Чат GPT проекта").selectOption(native.conversationId);
  await popup.getByRole("button", { name: "Выбрать чат", exact: true }).click();
  await expect(popup.getByText("Первый ответ", { exact: true })).toBeVisible();
  const firstReply = popup.locator(".message").filter({ hasText: "Первый ответ" });
  await firstReply.getByRole("button", { name: "В Issues", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "Подборка Issues", exact: true });
  await drawer.getByRole("button", { name: "Добавить в подборку" }).click();
  await expect(drawer.getByRole("textbox", { name: "Текст Issue", exact: true })).toHaveValue(
    "Первый ответ",
  );
  await drawer.getByRole("button", { name: "Закрыть подборку" }).click();
  const composer = popup.getByRole("textbox", { name: "Сообщение GPT", exact: true });
  await composer.fill("Черновик в окне проекта");
  await popup.getByLabel("Закрыть GPT проекта", { exact: true }).click();
  await open();
  await expect(composer).toHaveValue("Черновик в окне проекта");
  assert.equal(
    await page.evaluate(() => localStorage.getItem("gpt-conversation")),
    "ordinary-chat-selection",
  );
  await composer.fill("Обсудим совместимость World");
  await popup.getByRole("button", { name: "Отправить GPT", exact: true }).click();
  await expect.poll(() => native.state.sends).toBe(1);
  assert.match(native.state.input.text, /Контекст|контекст/);
  await popup.getByLabel("Закрыть GPT проекта", { exact: true }).click();
  native.state.finished = true;
  await expect
    .poll(() => f.store.db.prepare("SELECT status FROM gpt_jobs LIMIT 1").get()?.status, {
      timeout: 15000,
    })
    .toBe("completed");
  await open();
  await expect(popup.getByText("nativeworkspaceok", { exact: true })).toBeVisible();
  await expect(popup.locator(".project-gpt-envelope")).toHaveCount(1);
  assert.equal(await popup.locator(".project-gpt-envelope").getAttribute("open"), null);
  await popup.getByLabel("Настройки GPT проекта", { exact: true }).click();
  await popup.getByText("Дополнительные правила", { exact: true }).click();
  await popup.getByLabel("Запускать подходящие тесты и сборку", { exact: true }).check();
  await popup.getByLabel("Свои правила проекта").fill("Проверять API World.");
  await popup.getByRole("button", { name: "Применить правила", exact: true }).click();
  await expect(composer).toBeVisible();
  assert.match(await readFile(join(root, "CODEXWEB.md"), "utf8"), /Проверять API World/);
  await mkdir(".local/project-gpt-qa", { recursive: true });
  for (const width of [390, 768, 1024, 1366]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1024 });
    for (const theme of ["organizer", "crt-green", "hitech-2000s", "classic-dark"]) {
      await page.evaluate((t) => {
        document.documentElement.dataset.theme = t;
      }, theme);
      const b = await popup.evaluate((el) => {
        const r = el.getBoundingClientRect(),
          input = el.querySelector(".gpt-input-row textarea").getBoundingClientRect();
        return {
          left: r.left,
          right: r.right,
          top: r.top,
          bottom: r.bottom,
          inputBottom: input.bottom,
          overflow: el.scrollWidth > el.clientWidth + 1,
        };
      });
      assert.ok(
        b.left >= 0 &&
          b.right <= width + 1 &&
          b.top >= 0 &&
          b.inputBottom <= b.bottom &&
          !b.overflow,
        JSON.stringify({ width, theme, b }),
      );
      await popup.getByRole("button", { name: "Результаты", exact: true }).click();
      await expect(composer).toBeHidden();
      await popup.getByRole("button", { name: "Чат", exact: true }).click();
      await expect(composer).toBeVisible();
      if (width === 390 || width === 1024)
        await page.screenshot({ path: `.local/project-gpt-qa/${width}-${theme}.png` });
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  const bounds = await popup.evaluate((el) => {
    document.documentElement.dataset.keyboard = "true";
    document.documentElement.style.setProperty("--app-height", "400px");
    const r = el.getBoundingClientRect(),
      input = el.querySelector("textarea").getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, inputBottom: input.bottom };
  });
  assert.ok(
    bounds.top >= 0 && bounds.bottom <= 401 && bounds.inputBottom <= bounds.bottom,
    JSON.stringify(bounds),
  );
  await page.evaluate(() => {
    delete document.documentElement.dataset.keyboard;
    document.documentElement.style.setProperty("--app-height", "844px");
  });
  await popup.getByLabel("Закрыть GPT проекта", { exact: true }).click();
  await page.reload();
  await open();
  await expect(popup.getByText("nativeworkspaceok", { exact: true })).toBeVisible();
  assert.equal(native.state.sends, 1);
  assert.deepEqual(errors, []);
  console.log(
    "Project GPT: own binding, native send/completion, close/reopen/reload, draft, rules, compact Results and theme/phone/tablet/keyboard geometry passed.",
  );
} catch (error) {
  console.log(
    await popup.evaluate((el) =>
      [
        el,
        ...el.querySelectorAll(
          ".project-gpt-body,.project-gpt-embedded,.workspace-content,.gpt-chat,.gpt-message-scroll,.gpt-composer-wrap,.mobile-tabs",
        ),
      ].map((n) => ({
        class: n.className,
        rect: n.getBoundingClientRect().toJSON(),
        height: getComputedStyle(n).height,
        min: getComputedStyle(n).minHeight,
        position: getComputedStyle(n).position,
        flex: getComputedStyle(n).flex,
      })),
    ),
  );
  await mkdir(".local/project-gpt-qa", { recursive: true });
  await page.screenshot({ path: ".local/project-gpt-qa/failure.png" });
  console.log((await page.locator("body").innerText()).slice(-7000));
  throw error;
} finally {
  await browser.close();
  await f.close();
  await rm(root, { recursive: true, force: true });
}
