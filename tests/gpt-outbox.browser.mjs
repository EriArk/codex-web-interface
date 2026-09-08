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
      const jobs = [
        {
          id: "11111111-1111-4111-8111-111111111111",
          nativeId: null,
          text: "Old failed question",
          files: [
            {
              id: "file-old",
              name: "old.txt",
              url: "/api/gpt/uploads/file-old",
              mime: "text/plain",
              bytes: 3,
              image: false,
            },
          ],
          model: "Latest",
          effort: "2",
          status: "failed",
          error: "Preparation failed",
          createdAt: 1,
          updatedAt: 1,
          answer: "",
          assets: [],
        },
      ];
      let submissions = 0,
        releaseSend;
      const page = await context.newPage();
      await page.route("https://outbox.test/**", async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === "/fixture.js")
          return route.fulfill({ contentType: "application/javascript", body: js });
        if (path === "/fixture.css") return route.fulfill({ contentType: "text/css", body: css });
        if (path === "/")
          return route.fulfill({
            contentType: "text/html",
            body: '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script>',
          });
        if (/^\/fonts\/[a-zA-Z0-9._-]+\.woff2$/.test(path))
          return route.fulfill({
            contentType: "font/woff2",
            body: await readFile(resolve("apps/web/public" + path)),
          });
        if (path === "/icon.svg")
          return route.fulfill({
            contentType: "image/svg+xml",
            body: await readFile(resolve("apps/web/public/icon.svg")),
          });
        if (path === "/api/gpt/status")
          return route.fulfill({ json: { configured: true, canSend: true, state: "healthy" } });
        if (path === "/api/gpt/models")
          return route.fulfill({
            json: {
              models: [{ id: "Latest", label: "Latest" }],
              efforts: [{ id: "2", label: "High" }],
              currentModel: "Latest",
              currentEffort: "2",
            },
          });
        if (path === "/api/gpt/jobs")
          return route.fulfill({ json: { items: jobs, stamp: Date.now() } });
        if (path === "/api/gpt/send") {
          submissions++;
          const body = route.request().postDataJSON();
          await new Promise((resolve) => (releaseSend = resolve));
          const job = {
            ...jobs[0],
            ...body,
            files: [],
            id:
              submissions === 1
                ? "22222222-2222-4222-8222-222222222222"
                : "33333333-3333-4333-8333-333333333333",
            status: "running",
            error: "",
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
          if (body.replacesJobId) {
            assert.equal(body.replacesJobId, jobs[0].id);
            assert.deepEqual(body.files, ["file-old"]);
            jobs[0] = { ...jobs[0], dismissed: true, text: "", files: [], updatedAt: Date.now() };
            job.status = "failed";
            job.error = "Preparation failed";
          }
          jobs.push(job);
          return route.fulfill({ json: { job } });
        }
        if (path.endsWith("/dismiss")) {
          assert.deepEqual(route.request().postDataJSON(), { confirm: true });
          const id = path.split("/").at(-2),
            job = jobs.find((job) => job.id === id);
          assert.equal(job.status, "failed");
          Object.assign(job, { dismissed: true, text: "", files: [], updatedAt: Date.now() });
          return route.fulfill({ json: { job } });
        }
        return route.fulfill({ json: { items: [], conversations: [], nextOffset: null } });
      });
      await page.goto("https://outbox.test");
      const chat = page.locator(".gpt-chat"),
        draft = page.locator("textarea");
      await expect(
        page
          .locator(".desktop-nav")
          .locator(".nav-thread")
          .filter({ hasText: "Old failed question" }),
      ).toHaveCount(1);
      await expect(chat.locator(".gpt-job")).toHaveCount(0);
      const open = async () => {
        await page.getByRole("button", { name: "Открыть проекты", exact: true }).tap();
      };
      const newChat = async () => {
        await page
          .locator(".workspace-header")
          .getByRole("button", { name: "Новый чат GPT", exact: true })
          .tap();
      };
      await draft.fill("Unsent new draft");
      await open();
      await page
        .locator(".project-sheet")
        .locator(".nav-thread")
        .filter({ hasText: "Old failed question" })
        .tap();
      await expect(chat).toContainText("Preparation failed");
      await chat.getByRole("button", { name: "Вернуть в черновик" }).tap();
      await expect(draft).toHaveValue("Old failed question");
      await expect(page.locator(".gpt-composer")).toContainText("old.txt");
      await newChat();
      await expect(chat.locator(".gpt-job")).toHaveCount(0);
      await expect(draft).toHaveValue("Unsent new draft");
      await page.reload();
      await expect(chat.locator(".gpt-job")).toHaveCount(0);
      await expect(draft).toHaveValue("Unsent new draft");
      await open();
      await page
        .locator(".project-sheet")
        .locator(".nav-thread")
        .filter({ hasText: "Old failed question" })
        .tap();
      await expect(draft).toHaveValue("Old failed question");
      await page.reload();
      await expect(chat).toContainText("Preparation failed");
      await expect(draft).toHaveValue("Old failed question");
      assert.equal(submissions, 0, "Opening or restoring never resends");
      await newChat();
      await draft.fill("Delayed new submission");
      await page
        .locator(".gpt-composer")
        .getByRole("button", { name: "Отправить GPT", exact: true })
        .tap();
      await expect.poll(() => submissions).toBe(1);
      await newChat();
      releaseSend();
      await expect(
        page
          .locator(".desktop-nav")
          .locator(".nav-thread")
          .filter({ hasText: "Delayed new submission" }),
      ).toHaveCount(1);
      await expect(chat.locator(".gpt-job")).toHaveCount(0);
      await open();
      await page
        .locator(".project-sheet")
        .locator(".nav-thread")
        .filter({ hasText: "Delayed new submission" })
        .tap();
      await expect(chat).toContainText("Delayed new submission");
      await expect(page.locator(".project-sheet")).not.toBeVisible();
      await draft.fill("Next message while GPT starts");
      jobs[1].nativeId = "native-created-chat";
      jobs[1].updatedAt = Date.now();
      await expect
        .poll(() => page.evaluate(() => localStorage.getItem("gpt-conversation")))
        .toBe("native-created-chat");
      await expect(draft).toHaveValue("Next message while GPT starts");
      await page.reload();
      await expect(draft).toHaveValue("Next message while GPT starts");
      await page.setViewportSize({ width: 1366, height: 1024 });
      const box = await page.locator(".desktop-nav").boundingBox();
      assert(Math.abs(box.width - 295) < 1);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: `.local/qa-gpt-outbox/${name}.png` });
      await page.setViewportSize({ width: 390, height: 844 });
      await newChat();
      await open();
      await page
        .locator(".project-sheet .nav-thread")
        .filter({ hasText: "Old failed question" })
        .tap();
      await expect(page.locator(".project-sheet")).not.toBeVisible();
      await draft.fill("Revised question");
      await page
        .locator(".gpt-composer")
        .getByRole("button", { name: "Отправить GPT", exact: true })
        .tap();
      await expect.poll(() => submissions).toBe(2);
      releaseSend();
      await expect(chat).toContainText("Revised question");
      await expect(
        page.locator(".desktop-nav .nav-thread").filter({ hasText: "Old failed question" }),
      ).toHaveCount(0);
      await open();
      await page
        .locator(".project-sheet")
        .getByRole("button", { name: "Действия: Revised question", exact: true })
        .tap();
      const menu = page.locator(".entity-dialog");
      await expect(menu.getByRole("button", { name: "Закрепить", exact: true })).toHaveCount(0);
      await menu.getByRole("button", { name: "Удалить", exact: true }).tap();
      await expect(menu.getByRole("heading", { name: "Удалить отправку?" })).toBeVisible();
      await menu.getByRole("button", { name: "Отмена", exact: true }).tap();
      assert(!jobs[2].dismissed);
      await page
        .locator(".project-sheet")
        .getByRole("button", { name: "Действия: Revised question", exact: true })
        .tap();
      await menu.getByRole("button", { name: "Удалить", exact: true }).tap();
      await menu.getByRole("button", { name: "Удалить", exact: true }).tap();
      await expect(chat.locator(".gpt-job")).toHaveCount(0);
      await page.reload();
      await expect(
        page
          .locator(".desktop-nav .nav-thread")
          .filter({ hasText: /Old failed question|Revised question/ }),
      ).toHaveCount(0);
      assert.equal(submissions, 2, "Deletion and reload never replay sends");
      console.log(
        JSON.stringify({
          browser: name,
          cleanNewChat: true,
          recoveryWithFiles: true,
          scopedDrafts: true,
          reload: true,
          lateAckDoesNotHijack: true,
          sidebarWidth: 295,
        }),
      );
    } finally {
      await context.close();
      await browser.close();
    }
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}
