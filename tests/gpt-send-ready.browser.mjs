import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, expect, webkit } from "@playwright/test";
import react from "../apps/web/node_modules/@vitejs/plugin-react/dist/index.js";
import { build } from "../apps/web/node_modules/vite/dist/node/index.js";

const dir = await mkdtemp(join(tmpdir(), "gpt-send-ready-"));
try {
  await build({
    configFile: false,
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    root: resolve("apps/web"),
    plugins: [react()],
    logLevel: "error",
    build: {
      outDir: dir,
      emptyOutDir: true,
      lib: {
        entry: resolve("apps/web/tests/fixtures/gpt-outbox.tsx"),
        name: "GptOutboxFixture",
        formats: ["iife"],
        fileName: () => "fixture.js",
      },
    },
  });
  const js = await readFile(join(dir, "fixture.js"), "utf8"),
    css = (
      await Promise.all(
        (
          await readdir(dir)
        )
          .filter((f) => f.endsWith(".css"))
          .map((f) => readFile(join(dir, f), "utf8")),
      )
    ).join("\n");

  await mkdir(".local/qa-gpt-send-ready", { recursive: true });
  for (const [name, type] of [
    ["chromium", chromium],
    ["webkit", webkit],
  ]) {
    const browser = await type.launch(),
      context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        serviceWorkers: "block",
      });
    try {
      let releaseHistory,
        releaseModels,
        reads = 0,
        sends = 0;
      let releaseSend,
        job,
        live,
        serverEffort = "0";
      const page = await context.newPage();
      await page.addInitScript(() => localStorage.setItem("gpt-conversation", "history-chat"));
      await page.clock.install();
      await page.route("https://outbox.test/**", async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === "/fixture.js")
          return route.fulfill({ contentType: "application/javascript", body: js });
        if (path === "/fixture.css") return route.fulfill({ contentType: "text/css", body: css });
        if (path === "/")
          return route.fulfill({
            contentType: "text/html",
            body: '<!doctype html><meta charset="utf-8"><div id="root"></div><link rel="stylesheet" href="/fixture.css"><script src="/fixture.js"></script>',
          });
        if (path === "/api/gpt/status")
          return route.fulfill({ json: { configured: true, canSend: true, state: "healthy" } });
        if (path === "/api/gpt/models") {
          await new Promise((resolve) => {
            releaseModels = resolve;
          });
          return route.fulfill({
            json: {
              models: [{ id: "latest", label: "Latest" }],
              efforts: [
                { id: "0", label: "Instant" },
                { id: "2", label: "Extended" },
              ],
              currentModel: "latest",
              currentEffort: serverEffort,
            },
          });
        }
        if (path.endsWith("/history-chat/messages")) {
          reads++;
          await new Promise((resolve) => {
            releaseHistory = resolve;
          });
          return route.fulfill({
            json: {
              items: [
                {
                  id: "step",
                  role: "assistant",
                  phase: "commentary",
                  complete: true,
                  text: "Intermediate stays in Results",
                  createdAt: 1,
                  files: [],
                },
                {
                  id: "partial",
                  role: "assistant",
                  phase: "final",
                  complete: false,
                  text: "Partial final stays in progress",
                  createdAt: 1,
                  files: [],
                },
                { id: "reply", role: "assistant", text: "Saved reply", createdAt: 1, files: [] },
              ],
              nextBefore: null,
              revision: "v1",
            },
          });
        }
        if (path === "/api/gpt/jobs")
          return route.fulfill({ json: { items: job ? [job] : [], stamp: Date.now(), live } });
        if (path === "/api/gpt/send") {
          sends++;
          await new Promise((resolve) => {
            releaseSend = resolve;
          });
          job = {
            ...route.request().postDataJSON(),
            id: "receipt",
            files: [],
            status: "queued",
            answer: "",
            assets: [],
            error: "",
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
          return route.fulfill({ json: { job } });
        }
        return route.fulfill({
          json: { items: [], conversations: [], nextOffset: null, stamp: Date.now() },
        });
      });
      await page.goto("https://outbox.test/");
      const editor = page.getByRole("textbox", { name: "Сообщение GPT" });
      const button = page.locator(".gpt-composer button[type=submit]");
      await expect(editor).toBeVisible();
      await editor.fill("Draft while the chat loads");
      await expect(button).toBeDisabled();
      await expect(button.locator(".spinner")).toHaveCount(0);
      const loading = page.locator(".composer-loading .spinner");
      await expect(loading).toBeVisible();
      const ring = await loading.boundingBox(),
        field = await editor.boundingBox();
      assert(ring.y + ring.height <= field.y, "loading ring is above, not over the input");
      assert(
        await loading.evaluate(
          (el) =>
            parseFloat(getComputedStyle(el).width) <= 14 &&
            parseFloat(getComputedStyle(el).height) <= 14,
        ),
      );
      await page
        .locator(".gpt-composer")
        .evaluate((form) =>
          form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
        );
      assert.equal(sends, 0);
      await expect.poll(() => !!releaseHistory && !!releaseModels).toBe(true);
      releaseModels();
      await expect(button).toBeEnabled();
      await expect(button.locator(".spinner")).toHaveCount(0);
      await expect(editor).toHaveValue("Draft while the chat loads");
      await expect(loading).toBeVisible();
      await button.click();
      await expect.poll(() => sends).toBe(1);
      assert.equal(reads, 1, "history is still pending while the durable send is accepted");
      const progress = page.locator(".gpt-progress-toggle");
      await expect(progress).toContainText("Отправляется");
      await expect(progress.locator(".spinner")).toBeVisible();
      releaseSend();
      await expect(editor).toHaveValue("");
      releaseHistory();
      await expect(page.getByText("Saved reply", { exact: true })).toBeVisible();
      await expect(page.getByText("Intermediate stays in Results", { exact: true })).toHaveCount(0);
      await expect(page.getByText("Partial final stays in progress", { exact: true })).toHaveCount(
        0,
      );
      await expect(progress).toContainText("Отправляется");
      job.status = "unknown";
      job.updatedAt += 10000;
      await page.clock.fastForward(1500);
      await expect(progress).toContainText("Ожидаем ответ GPT");
      await expect(progress.locator(".spinner")).toBeVisible();
      job.status = "running";
      job.updatedAt += 10000;
      await page.clock.fastForward(1500);
      await expect(progress).toContainText("GPT работает");
      const effort = page.getByRole("combobox", { name: "Мощность GPT" });
      await expect(effort).toBeEnabled();
      await effort.selectOption("2");
      live = {
        jobId: job.id,
        items: [{ id: "public-message", text: "Live first line", state: "active" }],
      };
      await page.clock.fastForward(1500);
      await expect(progress).toContainText("GPT работает");
      await expect(progress).not.toContainText("Live first line");
      await progress.click();
      const details = page.getByRole("region", { name: "Этапы GPT" });
      await expect(details).toContainText("Live first line");
      live.items[0].text += "\n" + "Visible next line. ".repeat(100) + "LATEST";
      await page.clock.fastForward(1500);
      await expect(details).toContainText("LATEST");
      await expect(details.locator("li")).toHaveCount(1);
      await expect(progress).not.toContainText("LATEST");
      await details.evaluate((e) => {
        e.scrollTop = 0;
        e.dispatchEvent(new Event("scroll"));
      });
      live.items[0].text += "\nMore live output";
      await page.clock.fastForward(1500);
      await expect(details).toContainText("More live output");
      assert.equal(await details.evaluate((e) => e.scrollTop), 0);
      live.items.push({
        id: "action",
        text: "Просмотр материалов",
        activity: "review",
        state: "active",
      });
      await page.clock.fastForward(1500);
      await expect(progress).toContainText("Просмотр материалов");
      await expect(progress.locator("svg")).toHaveCount(2);
      // Missing optional live transport keeps the received text and ordinary job poll alive.
      live = null;
      await page.clock.fastForward(1500);
      await expect(details).toContainText("More live output");
      await page.screenshot({ path: `.local/qa-gpt-send-ready/${name}.png` });
      assert.equal(sends, 1);
      // Simulate PWA eviction: lose session state, retain only account-local choices.
      await page.evaluate(() => {
        window.dispatchEvent(new Event("pagehide"));
        sessionStorage.clear();
      });
      let releaseStatus;
      await page.route("https://outbox.test/api/gpt/status", async (route) => {
        await new Promise((resolve) => {
          releaseStatus = resolve;
        });
        return route.fulfill({ json: { configured: true, canSend: true, state: "healthy" } });
      });
      releaseModels = undefined;
      serverEffort = "2";
      await page.reload();
      await expect(page.getByRole("combobox", { name: "Модель GPT" })).toBeEnabled();
      await expect(effort).toBeEnabled();
      await expect(effort).toHaveValue("2");
      await expect.poll(() => typeof releaseModels).toBe("function");
      await effort.selectOption("0");
      await editor.fill("Still waiting for the connection");
      await expect(page.locator(".send-button")).toBeDisabled();
      releaseModels();
      await page.waitForResponse("https://outbox.test/api/gpt/models");
      await expect(effort).toHaveValue("0");
      releaseStatus();
      await expect(page.locator(".send-button")).toBeEnabled();
      assert.equal(sends, 1, "metadata refresh never sends the draft");
      await page.evaluate(() => window.dispatchEvent(new Event("private-session-ended")));
      assert.equal(await page.evaluate(() => localStorage.getItem("gpt-models-cache-v1")), null);
      // A new teammate must not inherit another account's catalog or selection.
      await page.evaluate(() => {
        sessionStorage.clear();
        sessionStorage.setItem("codex-workspace-identity", "22222222-2222-4222-8222-222222222222");
        localStorage.setItem(
          "cw-user:11111111-1111-4111-8111-111111111111:gpt-models-cache-v1",
          JSON.stringify({
            version: 1,
            model: "private-model",
            effort: "secret-power",
            models: {
              models: [{ id: "private-model", label: "Other account model" }],
              efforts: [{ id: "secret-power", label: "Private" }],
              currentModel: "private-model",
              currentEffort: "secret-power",
            },
          }),
        );
      });
      releaseModels = undefined;
      await page.reload();
      await expect(page.getByRole("combobox", { name: "Модель GPT" })).toBeDisabled();
      await expect(page.getByText("Other account model", { exact: true })).toHaveCount(0);
      await expect.poll(() => typeof releaseModels).toBe("function");
      releaseModels();
      await expect(page.getByRole("combobox", { name: "Модель GPT" })).toBeEnabled();
      await expect(effort).toHaveValue("2");
      await editor.fill("New account draft");
      await expect(page.locator(".send-button")).toBeDisabled();
      await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
      const ownChoices = await page.evaluate(() =>
        JSON.parse(
          localStorage.getItem("cw-user:22222222-2222-4222-8222-222222222222:gpt-models-cache-v1"),
        ),
      );
      assert.equal(ownChoices.model, "latest");
      assert.equal(ownChoices.effort, "2");
      assert.equal(sends, 1);
      console.log(
        name +
          ": queue/loading controls; cached model choices survive tab eviction and stay editable before connection; refresh preserves selection; logout clears choices",
      );
    } finally {
      await context.close();
      await browser.close();
    }
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}
