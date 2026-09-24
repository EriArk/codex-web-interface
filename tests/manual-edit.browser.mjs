import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, expect, webkit } from "@playwright/test";
import react from "../apps/web/node_modules/@vitejs/plugin-react/dist/index.js";
import { build } from "../apps/web/node_modules/vite/dist/node/index.js";
import { handoffFixture } from "./handoff-fixture.mjs";

const dir = await mkdtemp(join(tmpdir(), "manual-edit-"));
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
        entry: resolve("apps/web/tests/fixtures/manual-edit.tsx"),
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
  await mkdir(".local/qa-manual-edit", { recursive: true });
  for (const [engine, type] of [
    ["chromium", chromium],
    ["webkit", webkit],
  ]) {
    const origin = "http://127.0.0.1:18977",
      f = await handoffFixture(origin),
      browser = await type.launch(),
      context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        acceptDownloads: true,
      });
    const root = await mkdtemp(join(tmpdir(), "manual-copy-"));
    f.sessions.config.machines[0].type = "local-linux";
    f.sessions.config.projects[0].workingDirectory = root;
    await writeFile(join(root, "Report.md"), "Keep original");
    try {
      await f.app.listen({ host: "127.0.0.1", port: 18977 });
      const [name, value] = f.headers.cookie.split("=");
      await context.addCookies([{ name, value, url: origin }]);
      let commits = 0,
        operation;
      await context.route(origin + "/**", async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === "/")
          return route.fulfill({
            contentType: "text/html",
            body:
              '<!doctype html><html data-theme="crt-green"><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script>window.fixtureCsrf=' +
              JSON.stringify(f.headers["x-csrf-token"] ?? f.headers["x-csrf"] ?? "") +
              '</script><script src="/fixture.js"></script>',
          });
        if (path === "/fixture.js")
          return route.fulfill({ contentType: "application/javascript", body: js });
        if (path === "/fixture.css") return route.fulfill({ contentType: "text/css", body: css });
        if (path.includes("/text-artifacts/"))
          return route.fulfill({
            contentType: "text/markdown",
            body: "# Original\r\nComplete text\r\n",
          });
        if (path.includes("/github-files")) {
          const body = route.request().postDataJSON();
          if (path.endsWith("/read"))
            return route.fulfill({
              json: {
                repository: "Owner/Repo",
                repositoryId: 51,
                identity: { id: 11, login: "Owner" },
                binding: "binding",
                repositoryFiles: {
                  branch: body.branch || "main",
                  head: "a".repeat(40),
                  path: body.path,
                  ...(body.path
                    ? {
                        file: {
                          path: body.path,
                          sha: "b".repeat(40),
                          content: Buffer.from("# Original\r\n").toString("base64"),
                          bytes: 12,
                        },
                      }
                    : { entries: [{ name: "README.md", path: "README.md", kind: "file" }] }),
                },
              },
            });
          if (path.endsWith("/prepare")) {
            operation = {
              id: path.split("/").at(-2),
              state: "prepared",
              receipt: { fingerprint: "fingerprint" },
            };
            return route.fulfill({ json: operation });
          }
          if (path.endsWith("/confirm")) {
            commits++;
            operation.state = "completed";
            return route.abort("failed");
          }
          return route.fulfill({ json: operation });
        }
        return route.continue();
      });
      const page = await context.newPage(),
        errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(origin);
      const editor = page.locator(".file-editor[open]"),
        copy = page.locator(".file-copy-save[open]"),
        viewer = page.locator(".file-viewer-dialog[open]");
      await page.getByRole("button", { name: "Открыть отчёт", exact: true }).click();
      await viewer.getByRole("button", { name: "Редактировать", exact: true }).click();
      await expect(editor.locator(".cm-content")).toContainText("Complete text");
      await editor.locator(".cm-content").fill("# Changed\nFull edited bytes\n");
      await editor.getByRole("button", { name: "Сохранить как…", exact: true }).click();
      await expect(copy).toBeVisible();
      const download = page.waitForEvent("download");
      await copy.getByRole("link", { name: "Скачать копию" }).click();
      assert.equal(
        await readFile(await (await download).path(), "utf8"),
        "# Changed\r\nFull edited bytes\r\n",
      );
      await page.screenshot({ path: `.local/qa-manual-edit/${engine}-copy.png` });
      await copy.getByLabel("Проект для копии").selectOption("project");
      await copy.getByRole("button", { name: "Сохранить в проект", exact: true }).click();
      const upload = page.locator(".project-file-upload[open]");
      await expect(upload).toBeVisible();
      await page.screenshot({ path: `.local/qa-manual-edit/${engine}-upload.png` });
      await page.getByRole("button", { name: "Загрузить", exact: true }).click();
      await page.getByRole("button", { name: "Заменить старый", exact: true }).click();
      await page.getByRole("button", { name: "Загрузить", exact: true }).click();
      await expect
        .poll(() => readFile(join(root, "Report.md"), "utf8"))
        .toBe("# Changed\r\nFull edited bytes\r\n");
      await expect(copy).toHaveCount(0);
      await editor.getByRole("button", { name: "Закрыть редактор", exact: true }).click();
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Файлы GitHub", exact: true }).click();
      const gh = page.locator(".github-files[open]"),
        review = page.locator(".github-file-review[open]");
      await gh.getByRole("button", { name: "README.md", exact: true }).click();
      await gh.getByRole("button", { name: "Редактировать файл" }).click();
      await editor.locator(".cm-content").fill("# Remote change\n");
      await editor.getByRole("button", { name: "Проверить изменения", exact: true }).click();
      await expect(review).toContainText("+# Remote change");
      for (const theme of ["organizer", "crt-green", "hitech-2000s", "classic-dark"]) {
        await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
        for (const [label, w, h] of [
          ["phone", 390, 844],
          ["keyboard", 390, 460],
          ["tablet", 768, 1024],
          ["wide", 1366, 1024],
        ]) {
          await page.setViewportSize({ width: w, height: h });
          const box = await review.boundingBox();
          assert(
            box.x >= 0 && box.y >= 0 && box.x + box.width <= w + 1 && box.y + box.height <= h + 1,
          );
          await page.screenshot({ path: `.local/qa-manual-edit/${engine}-${theme}-${label}.png` });
        }
      }
      await review.getByRole("button", { name: "Подготовить коммит" }).click();
      await review.getByRole("button", { name: "Создать коммит" }).click();
      await expect(review.getByRole("alert")).toBeVisible();
      assert.equal(commits, 1);
      await page.reload();
      await page.getByRole("button", { name: "Файлы GitHub", exact: true }).click();
      await expect(review).toContainText("+# Remote change");
      await review.getByRole("button", { name: "Проверить результат" }).click();
      await expect(review).toContainText("Коммит сохранён");
      await review.getByRole("button", { name: "Готово", exact: true }).click();
      assert.equal(commits, 1);
      assert.deepEqual(errors, []);
      console.log(
        engine +
          ": complete copy edit/download/project collision; GitHub review/lost ack/reload/status; four themes and keyboard geometry captured",
      );
    } finally {
      await browser.close();
      await f.close();
      await rm(root, { recursive: true, force: true });
    }
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}
