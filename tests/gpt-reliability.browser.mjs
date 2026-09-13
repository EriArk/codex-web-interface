import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, expect, webkit } from "@playwright/test";
import react from "../apps/web/node_modules/@vitejs/plugin-react/dist/index.js";
import { build } from "../apps/web/node_modules/vite/dist/node/index.js";

const dir = await mkdtemp(join(tmpdir(), "codex-copy-"));
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

  await mkdir(".local/qa-gpt-outbox", { recursive: true });
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
      const attempts = [];
      let mode = "lost",
        polls = 0,
        catalogFailures = 0;
      const accepted = new Map();
      let retryJobs = [];
      const page = await context.newPage();
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
          return route.fulfill({
            json:
              mode === "attention"
                ? {
                    configured: true,
                    canSend: false,
                    state: "attention",
                    message: "В ChatGPT открыто окно, требующее внимания.",
                  }
                : { configured: true, canSend: true, state: "healthy" },
          });
        if (path === "/api/gpt/conversations" && mode === "catalog-fail") {
          catalogFailures++;
          return route.fulfill({
            status: 503,
            json: { error: { code: "GPT_CONNECTION_LOST", message: "Temporary catalog outage" } },
          });
        }
        if (path === "/api/gpt/models")
          return route.fulfill({
            json: {
              models: [{ id: "Latest", label: "Latest" }],
              efforts: [{ id: "2", label: "High" }],
              currentModel: "Latest",
              currentEffort: "2",
            },
          });
        if (path === "/api/gpt/conversations/history-chat/messages") {
          if (mode === "history-error")
            return route.fulfill({
              status: 429,
              json: {
                error: {
                  code: "GPT_HISTORY_RATE_LIMITED",
                  message:
                    "ChatGPT временно ограничил обновление истории. Повторим автоматически после паузы.",
                },
              },
            });
          return route.fulfill({
            json: {
              ...(mode === "history-retained"
                ? {
                    stale: true,
                    refreshMessage:
                      "Показана сохранённая история. Обновление временно недоступно; повторим автоматически.",
                  }
                : {}),
              items: [
                {
                  id: "public-answer",
                  role: "assistant",
                  text: "Сохранённый настоящий ответ",
                  files: [],
                  createdAt: 100,
                },
              ],
              nextBefore: null,
              revision: "a".repeat(64),
              prefix: "",
              notModified: false,
              retainOlder: false,
            },
          });
        }
        if (path === "/api/gpt/jobs") {
          polls++;
          if (mode === "hang") return;
          return route.fulfill({ json: { items: retryJobs, stamp: Date.now() } });
        }
        if (path === "/api/gpt/send") {
          attempts.push({
            key: route.request().headers()["idempotency-key"],
            body: route.request().postDataJSON(),
          });
          const attempt = attempts.at(-1);
          if (!accepted.has(attempt.key))
            accepted.set(attempt.key, {
              ...attempt.body,
              id: attempt.key,
              files: [],
              nativeId: null,
              status: "queued",
              answer: "",
              assets: [],
              error: "",
              createdAt: Date.now(),
              updatedAt: Date.now(),
            });
          if (attempts.length === 1) return route.abort("connectionreset");
          if (mode === "send-hang") return;
          return route.fulfill({ json: { job: accepted.get(attempt.key) } });
        }
        return route.fulfill({ json: { items: [], conversations: [], nextOffset: null } });
      });
      await page.clock.install();
      await page.goto("https://outbox.test");
      const editor = page.locator("textarea");
      await expect(editor).toBeVisible();
      await editor.fill("Audit: same preserved draft");
      const send = page.locator('.gpt-composer button[type="submit"]');
      // The shared composer uses an explicit send control rather than form submission.
      const button = page.locator("form button[type=submit]");
      await expect(button).toBeEnabled();
      await button.click();
      await expect.poll(() => attempts.length).toBe(1);
      await expect(button).toBeEnabled();
      // Reauthentication clears message caches, but keeps the existing draft and its receipt together.
      await page.evaluate(() => window.dispatchEvent(new Event("private-session-ended")));
      await page.reload();
      await expect(editor).toHaveValue("Audit: same preserved draft");
      await expect(button).toBeEnabled();
      await button.click();
      await expect.poll(() => attempts.length).toBe(2);
      assert.deepEqual(attempts[0].body, attempts[1].body);
      assert.equal(attempts[0].key, attempts[1].key);
      assert.equal(accepted.size, 1);
      await expect(editor).toHaveValue("");
      console.log(
        name + ": lost ACK and reload reuse one GPT job and clear the acknowledged draft",
      );
      mode = "hang";
      await page.reload();
      await expect.poll(() => polls).toBeGreaterThan(1);
      const start = polls;
      await page.clock.runFor(180000);
      await page.evaluate(() => {
        document.dispatchEvent(new Event("visibilitychange"));
        window.dispatchEvent(new Event("online"));
      });
      await page.clock.runFor(10000);
      assert.ok(polls > start + 1);
      console.log(
        name + ": stalled jobs requests recover with bounded retry after visibility/online events",
      );
      mode = "send-hang";
      await editor.fill("Write timeout preserves receipt");
      await button.click();
      await expect.poll(() => attempts.length).toBe(3);
      await page.clock.runFor(136000);
      await expect(button).toBeEnabled();
      assert.equal(attempts.length, 3);
      await expect(editor).toHaveValue("Write timeout preserves receipt");
      mode = "ok";
      await button.click();
      await expect.poll(() => attempts.length).toBe(4);
      assert.equal(attempts[2].key, attempts[3].key);
      assert.equal(accepted.size, 2);
      await expect(editor).toHaveValue("");
      console.log(
        name +
          ": timed-out write never replays automatically; explicit retry reconciles the saved receipt",
      );
      mode = "catalog-fail";
      await page.evaluate(() => window.dispatchEvent(new Event("private-session-ended")));
      await page.reload();
      await expect.poll(() => catalogFailures).toBeGreaterThan(0);
      await page.clock.runFor(12000);
      await expect.poll(() => catalogFailures).toBeGreaterThan(2);
      await expect(page.locator(".global-notice")).toBeVisible();
      const beforeRecovery = attempts.length;
      mode = "ok";
      await page.clock.runFor(16000);
      await expect(page.locator(".global-notice")).toHaveCount(0);
      assert.equal(attempts.length, beforeRecovery, "metadata recovery never replays a send");
      console.log(name + ": metadata loads recover automatically and clear only their own notice");
      await editor.fill("Draft while native dialog is open");
      mode = "attention";
      await page.clock.runFor(10000);
      await expect(
        page.locator(".gpt-connection-notice").getByRole("link", { name: "Открыть" }),
      ).toHaveAttribute("href", "/gpt-connect");
      await expect(button).toBeDisabled();
      await expect(editor).toHaveValue("Draft while native dialog is open");
      await page.screenshot({ path: `.local/qa-gpt-outbox/attention-${name}.png` });
      mode = "ok";
      await page.clock.runFor(10000);
      await expect(page.locator(".gpt-connection-notice")).toHaveCount(0);
      await expect(button).toBeEnabled();
      assert.equal(attempts.length, beforeRecovery);
      console.log(
        name + ": native attention has a direct Open action and preserves an unsent draft",
      );
      await page.evaluate(() => {
        window.dispatchEvent(new Event("private-session-ended"));
        localStorage.setItem("gpt-conversation", "history-chat");
      });
      await page.reload();
      await expect(page.getByText("Сохранённый настоящий ответ", { exact: true })).toBeVisible();
      await editor.fill("Черновик во время задержки истории");
      mode = "history-error";
      await page.clock.runFor(31000);
      const sync = page.getByRole("status", { name: "Обновление истории" });
      await expect(sync).toContainText("ограничил обновление истории");
      await expect(page.locator(".global-notice")).toHaveCount(0);
      await expect(editor).toHaveValue("Черновик во время задержки истории");
      await expect(page.getByText("Сохранённый настоящий ответ", { exact: true })).toBeVisible();
      await page.screenshot({ path: `.local/qa-gpt-outbox/history-cooldown-${name}.png` });
      await page.setViewportSize({ width: 1366, height: 1024 });
      await expect(sync).toBeVisible();
      await page.screenshot({ path: `.local/qa-gpt-outbox/history-cooldown-tablet-${name}.png` });
      await page.setViewportSize({ width: 390, height: 844 });
      mode = "ok";
      await page.clock.runFor(16000);
      await expect(sync).toHaveCount(0);
      await expect(editor).toHaveValue("Черновик во время задержки истории");
      assert.equal(attempts.length, beforeRecovery, "history recovery never sends a message");
      console.log(
        name +
          ": history throttling keeps messages and draft, uses inline sync status and clears on recovery",
      );
      // No client cache: a restarted Hub can still supply its saved public branch.
      mode = "history-retained";
      await page.evaluate(() => window.dispatchEvent(new Event("private-session-ended")));
      await page.reload();
      await expect(page.getByText("Сохранённый настоящий ответ", { exact: true })).toBeVisible();
      await expect(sync).toContainText("сохранённая история");
      await expect(page.locator(".gpt-history-state")).toHaveCount(0);
      await expect(page.locator(".global-notice")).toHaveCount(0);
      await expect(editor).toHaveValue("Черновик во время задержки истории");
      await page.screenshot({ path: `.local/qa-gpt-outbox/history-cold-retained-${name}.png` });
      // With no saved branch at all, explicit Retry owns one local error, never a second banner.
      mode = "history-error";
      await page.evaluate(() => window.dispatchEvent(new Event("private-session-ended")));
      await page.reload();
      await page.getByRole("button", { name: "Повторить загрузку" }).click();
      await expect(page.locator(".global-notice")).toHaveCount(0);
      await expect(
        page.getByText(
          "ChatGPT временно ограничил обновление истории. Повторим автоматически после паузы.",
          { exact: true },
        ),
      ).toHaveCount(1);
      mode = "ok";
      await page.clock.runFor(16000);
      await expect(editor).toHaveValue("Черновик во время задержки истории");
      console.log(
        name + ": cold reload retains Hub history; manual Retry never duplicates the history error",
      );
      const now = await page.evaluate(() => Date.now());
      const failed = {
        id: "failed-attempt",
        nativeId: "retry-chat",
        text: "Same restored question",
        files: [],
        model: "Latest",
        effort: "2",
        status: "failed",
        answer: "",
        assets: [],
        error: "Old preparation failure",
        createdAt: now - 60000,
        updatedAt: now - 55000,
      };
      retryJobs = [
        failed,
        {
          ...failed,
          id: "completed-retry",
          status: "completed",
          answer: "Successful retry result",
          error: "",
          createdAt: now - 40000,
          updatedAt: now - 30000,
        },
        {
          ...failed,
          id: "unknown-send",
          status: "unknown",
          error: "Unknown outcome must remain",
          createdAt: now - 20000,
          updatedAt: now - 10000,
        },
      ];
      await page.evaluate(() => {
        window.dispatchEvent(new Event("private-session-ended"));
        localStorage.setItem("gpt-conversation", "retry-chat");
        sessionStorage.setItem(
          "gpt-draft-retry-chat",
          JSON.stringify({ text: "An intentional unsent draft", files: [] }),
        );
      });
      await page.reload();
      await expect(page.locator(".gpt-job")).toContainText([
        "Successful retry result",
        "Unknown outcome must remain",
      ]);
      await expect(
        page.locator(".gpt-job-error").filter({ hasText: "Old preparation failure" }),
      ).toHaveCount(0);
      await expect(
        page.locator(".gpt-job-error").filter({ hasText: "Unknown outcome must remain" }),
      ).toBeVisible();
      await expect(editor).toHaveValue("An intentional unsent draft");
      assert.equal(
        attempts.length,
        beforeRecovery,
        "retry reconciliation never sends or erases a draft",
      );
      console.log(
        name +
          ": successful retry hides obsolete failure while unknown sends and unrelated drafts remain",
      );
    } finally {
      await context.close();
      await browser.close();
    }
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}
