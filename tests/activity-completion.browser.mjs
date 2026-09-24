import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, expect, webkit } from "@playwright/test";
import react from "../apps/web/node_modules/@vitejs/plugin-react/dist/index.js";
import { build } from "../apps/web/node_modules/vite/dist/node/index.js";

const engine = process.env.BROWSER ?? "webkit",
  dir = await mkdtemp(join(tmpdir(), "activity-completion-"));
let browser;
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
        entry: resolve("apps/web/tests/fixtures/activity-completion.tsx"),
        name: "Fixture",
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
          .filter((n) => n.endsWith(".css"))
          .map((n) => readFile(join(dir, n), "utf8")),
      )
    ).join("\n");
  browser = await (engine === "webkit" ? webkit : chromium).launch();
  const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      serviceWorkers: "allow",
    }),
    page = await context.newPage(),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  let local = [
    {
      id: "result:grant",
      kind: "result",
      at: Date.now(),
      author: { id: "me", name: "Автор" },
      title: "Опубликован результат",
      result: {
        id: "11111111-1111-4111-8111-111111111111",
        snapshotId: "snap",
        title: "План разработки.md",
        mime: "text/markdown",
        bytes: 38,
        sha256: "a".repeat(64),
        createdAt: Date.now(),
        revoked: false,
      },
    },
    ...Array.from({ length: 25 }, (_, i) => ({
      id: "event" + i,
      at: Date.now() - 1000 * (i + 1),
      author: { id: "me", name: "Автор" },
      kind: "joined",
      title: "Участник " + i + " присоединился",
    })),
  ];
  let release,
    hold = false,
    read = false;
  const source = {
    kind: "pr",
    key: "pr:12",
    number: 12,
    sha: "a".repeat(40),
    title: "Проверка совместимости старых сохранений",
    author: { id: 7, login: "Developer" },
    authorName: "Developer",
    state: "open",
    at: new Date(Date.now() - 500).toISOString(),
    url: "https://github.com/example/project/pull/12",
    checks: { sha: "a".repeat(40), state: "failure", total: 3, failed: 1 },
    attention: [{ kind: "checks", version: "run1" }],
  };
  await context.route("http://activity.test/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/")
      return route.fulfill({
        contentType: "text/html",
        body: '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><link rel="stylesheet" href="/fixture.css"><script src="/fixture.js"></script>',
      });
    if (path === "/fixture.js")
      return route.fulfill({ contentType: "application/javascript", body: js });
    if (path === "/fixture.css") return route.fulfill({ contentType: "text/css", body: css });
    if (path.endsWith("/activity/local")) {
      if (hold)
        await new Promise((r) => {
          release = r;
        });
      return route.fulfill({ json: { items: local } });
    }
    if (path.endsWith("/activity/github-read")) {
      assert.deepEqual(route.request().postDataJSON().versions, ["assigned", "run1"]);
      read = true;
      return route.fulfill({ json: { read: true } });
    }
    if (path.endsWith("/activity/source"))
      return route.fulfill({
        json: {
          repository: "example/project",
          repositoryId: 42,
          identity: { id: 7, login: "Developer" },
          access: "read",
          query: { kind: "detail", type: "pr", number: 12, page: 1 },
          record: {
            type: "pr",
            number: 12,
            title: source.title,
            body: "Exact internal PR",
            author: source.author,
            state: "open",
            url: source.url,
            updatedAt: source.at,
            createdAt: source.at,
            comments: 0,
            assignees: [],
            labels: [],
            checks: [],
            checksKnown: true,
          },
        },
      });
    if (path.endsWith("/activity"))
      return route.fulfill({
        json: {
          projectId: "project",
          repositoryId: 42,
          repository: "example/project",
          viewerId: 7,
          checkedAt: Date.now(),
          items: [
            {
              ...source,
              attention: [
                { kind: "assigned", version: "assigned", read },
                { kind: "checks", version: "run1", read },
              ],
            },
          ],
        },
      });
    if (path === "/api/team/result-shares/11111111-1111-4111-8111-111111111111")
      return route.fulfill({
        json: {
          id: "snap",
          title: "План разработки.md",
          mime: "text/markdown",
          bytes: 38,
          sha256: "a".repeat(64),
        },
      });
    if (path === "/api/team/result-shares/11111111-1111-4111-8111-111111111111/content")
      return route.fulfill({
        contentType: "text/markdown",
        body: "# Точный опубликованный материал",
      });
    return route.fulfill({ json: {} });
  });
  await page.goto("http://activity.test/");
  const win = page.locator("dialog.activity-dialog"),
    feed = win.locator(".activity-feed");
  await expect(
    win.getByRole("heading", { name: "Опубликован результат", exact: true }),
  ).toBeVisible();
  await win.getByRole("button", { name: "Открыть результат", exact: true }).click();
  await expect(page.locator(".file-viewer-dialog")).toContainText("Точный опубликованный материал");
  await page.getByRole("button", { name: "Закрыть просмотр", exact: true }).click();
  await expect(win.getByText("Проверки: ошибки", { exact: false })).toBeVisible();
  await win.getByRole("button", { name: "Показать ещё", exact: true }).click();
  await feed.evaluate((e) => {
    e.scrollTop = 500;
  });
  const top = await feed.evaluate((e) => e.scrollTop);
  hold = true;
  await win.getByRole("button", { name: "Обновить активность", exact: true }).click();
  await expect.poll(() => !!release).toBe(true);
  await expect(win.locator(".activity-card")).toHaveCount(27);
  assert.equal(await feed.evaluate((e) => e.scrollTop), top);
  release();
  hold = false;
  await expect(win.getByRole("button", { name: "Обновить активность", exact: true })).toBeEnabled();
  await feed.evaluate((e) => {
    e.scrollTop = 0;
  });
  await mkdir(".local/qa-activity-completion", { recursive: true });
  for (const theme of ["organizer", "crt-green", "hitech-2000s", "classic-dark"])
    for (const [width, height] of [
      [390, 844],
      [390, 500],
      [768, 1024],
      [1024, 768],
      [1366, 1024],
    ]) {
      await page.setViewportSize({ width, height });
      await page.evaluate((t) => {
        document.documentElement.dataset.theme = t;
        document.documentElement.dataset.caseColor =
          t === "hitech-2000s" ? "turquoise" : t === "classic-dark" ? "blue" : "green";
      }, theme);
      await page.waitForTimeout(150);
      assert(await win.evaluate((e) => e.scrollWidth <= e.clientWidth + 1));
      await page.screenshot({
        animations: "disabled",
        path: `.local/qa-activity-completion/${engine}-${theme}-${width}x${height}.png`,
      });
    }
  await win.getByRole("button", { name: "Уведомления", exact: true }).click();
  await expect(
    win.getByText("Проверки твоего PR требуют внимания", { exact: false }),
  ).toBeVisible();
  for (const theme of ["organizer", "crt-green", "hitech-2000s", "classic-dark"]) {
    await page.setViewportSize({ width: 390, height: 500 });
    await page.evaluate((t) => {
      document.documentElement.dataset.theme = t;
      document.documentElement.dataset.caseColor =
        t === "hitech-2000s" ? "turquoise" : t === "classic-dark" ? "blue" : "green";
    }, theme);
    await page.waitForTimeout(150);
    await page.screenshot({
      animations: "disabled",
      path: `.local/qa-activity-completion/${engine}-${theme}-notices.png`,
    });
  }
  await expect(win.locator(".space-card")).toHaveCount(1);
  await win.getByRole("button", { name: "Открыть PR", exact: true }).click();
  await expect(page.getByText("Exact internal PR", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Закрыть событие", exact: true }).click();
  await win.getByRole("button", { name: "Прочитано", exact: true }).click();
  await expect(win.locator(".space-card")).toHaveCount(0);
  assert(read);
  await win.getByRole("button", { name: "Лента", exact: true }).click();
  await expect(
    win.getByRole("heading", { name: "Опубликован результат", exact: true }),
  ).toBeVisible();
  local = local.filter((v) => v.kind !== "result");
  await win.getByRole("button", { name: "Обновить активность", exact: true }).click();
  await expect(win.getByRole("button", { name: "Открыть результат", exact: true })).toHaveCount(0);
  assert.deepEqual(errors, []);
  console.log(engine + " activity completion browser passed");
} finally {
  await browser?.close();
  await rm(dir, { recursive: true, force: true });
}
