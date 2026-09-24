import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, expect, webkit } from "@playwright/test";
import react from "../apps/web/node_modules/@vitejs/plugin-react/dist/index.js";
import { build } from "../apps/web/node_modules/vite/dist/node/index.js";
import { handoffFixture } from "./handoff-fixture.mjs";

const withPr = process.env.WITH_PR === "1";
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
        branches = 0,
        prs = 0,
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
        if (path.endsWith("/intake/source"))
          return route.fulfill({
            json: {
              repository: "Owner/Repo",
              repositoryId: 51,
              record: {
                type: "pr",
                number: 78,
                title: "Reviewed file change",
                body: "Details",
                state: "open",
                author: { id: 11, login: "Owner" },
                labels: [],
                assignees: [],
                updatedAt: new Date(0).toISOString(),
              },
              commentsPage: [],
            },
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
              receipt: {
                fingerprint: "fingerprint",
                input: body.input,
                snapshot: { identity: { id: 11, login: "Owner" } },
                updatedAt: Date.now(),
                result: {
                  sha: "c".repeat(40),
                  number: 78,
                  url: "https://github.com/Owner/Repo/pull/78",
                },
              },
            };
            return route.fulfill({ json: operation });
          }
          if (path.endsWith("/confirm")) {
            if (operation.receipt.input.kind === "repository-branch") branches++;
            else if (operation.receipt.input.kind === "repository-pr") prs++;
            else commits++;
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
      if (withPr) {
        await review.getByLabel("Куда сохранить коммит").selectOption("new");
        await review.getByLabel("Название новой ветки").fill("edit/readme");
        await review.getByRole("button", { name: "Подготовить ветку", exact: true }).click();
        await review.getByRole("button", { name: "Создать ветку", exact: true }).click();
        await expect(review.getByRole("alert")).toBeVisible();
        assert.equal(branches, 1);
        await page.reload();
        await page.getByRole("button", { name: "Файлы GitHub", exact: true }).click();
        await expect(review).toContainText("+# Remote change");
        await review.getByRole("button", { name: "Проверить результат" }).click();
        await expect(review).toContainText("Создана");
        await review.getByRole("button", { name: "К редактору", exact: true }).click();
        await expect(editor.locator(".cm-content")).toContainText("# Remote change");
        await editor.getByRole("button", { name: "Проверить изменения", exact: true }).click();
        await expect(review).toContainText("edit/readme");
        await expect(review).toContainText("+# Remote change");
      }
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
      if (withPr) {
        await review.getByRole("button", { name: "Создать PR", exact: true }).click();
        await expect(review.getByLabel("Базовая ветка PR")).toHaveValue("main");
        await review.getByLabel("Заголовок PR").fill("Reviewed file change");
        await review.getByLabel("Описание PR").fill("Details");
        await page.reload();
        await page.getByRole("button", { name: "Файлы GitHub", exact: true }).click();
        await expect(review.getByLabel("Описание PR")).toHaveValue("Details");
        for (const theme of ["organizer", "crt-green", "hitech-2000s", "classic-dark"]) {
          await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
          for (const [label, width, height] of [
            ["phone", 390, 844],
            ["keyboard", 390, 460],
            ["tablet", 768, 1024],
            ["wide", 1366, 1024],
          ]) {
            await page.setViewportSize({ width, height });
            const box = await review.boundingBox();
            assert(
              box.x >= 0 &&
                box.y >= 0 &&
                box.x + box.width <= width + 1 &&
                box.y + box.height <= height + 1,
            );
            await page.screenshot({
              path: `.local/qa-manual-edit/${engine}-pr-${theme}-${label}.png`,
            });
          }
        }
        await review.getByRole("button", { name: "Подготовить PR", exact: true }).click();
        await review.getByRole("button", { name: "Опубликовать PR", exact: true }).click();
        await expect(review.getByRole("alert")).toBeVisible();
        assert.equal(prs, 1);
        await page.reload();
        await page.getByRole("button", { name: "Файлы GitHub", exact: true }).click();
        await review.getByRole("button", { name: "Проверить результат" }).click();
        await expect(review).toContainText("PR создан");
        await review.getByRole("button", { name: "Открыть PR", exact: true }).click();
        await expect(
          page.getByRole("heading", { name: "PR #78 · Reviewed file change" }),
        ).toBeVisible();
        assert.equal(page.url(), origin + "/");
        await page.keyboard.press("Escape");
        await expect(review).toBeVisible();
        assert.equal(branches, 1);
        assert.equal(prs, 1);
      }
      await review.getByRole("button", { name: "Готово", exact: true }).click();
      assert.equal(commits, 1);
      if (process.env.WITH_MANAGEMENT === "1") {
        const finishCommit = async () => {
          await review.getByRole("button", { name: "Подготовить коммит", exact: true }).click();
          await review.getByRole("button", { name: "Создать коммит", exact: true }).click();
          await expect(review.getByRole("alert")).toBeVisible();
          await expect(
            review.getByRole("button", { name: "Отменить изменение", exact: true }),
          ).toHaveCount(0);
          await page.reload();
          await page.getByRole("button", { name: "Файлы GitHub", exact: true }).click();
          await review.getByRole("button", { name: "Проверить результат", exact: true }).click();
          await expect(review).toContainText("Коммит сохранён");
          await review.getByRole("button", { name: "Готово", exact: true }).click();
        };
        await gh.getByRole("button", { name: "Новый файл", exact: true }).click();
        await gh.getByLabel("Путь файла", { exact: true }).fill("docs/new.md");
        await gh.getByRole("button", { name: "Открыть редактор", exact: true }).click();
        await expect(editor.locator(".cm-content")).toBeEmpty();
        await editor.getByRole("button", { name: "Проверить изменения", exact: true }).click();
        await expect(review).toContainText("Создание");
        await expect(review).toContainText("docs/new.md");
        await page.reload();
        await page.getByRole("button", { name: "Файлы GitHub", exact: true }).click();
        await review.getByRole("button", { name: "К редактору", exact: true }).click();
        await editor.locator(".cm-content").fill("# Created file");
        await editor.getByRole("button", { name: "Проверить изменения", exact: true }).click();
        await expect(review).toContainText("+# Created file");
        await finishCommit();
        assert.equal(operation.receipt.input.files[0].previous, null);
        assert.equal(
          Buffer.from(operation.receipt.input.files[0].content, "base64").toString(),
          "# Created file",
        );
        await gh.getByRole("button", { name: "Переименовать", exact: true }).click();
        await gh.getByLabel("Путь файла", { exact: true }).fill("docs/renamed.md");
        for (const theme of ["organizer", "crt-green", "hitech-2000s", "classic-dark"]) {
          await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
          for (const [label, width, height] of [
            ["phone", 390, 844],
            ["keyboard", 390, 460],
            ["tablet", 768, 1024],
          ]) {
            await page.setViewportSize({ width, height });
            const box = await gh.boundingBox();
            assert(
              box.x >= 0 &&
                box.y >= 0 &&
                box.x + box.width <= width + 1 &&
                box.y + box.height <= height + 1,
            );
            await page.screenshot({
              path: `.local/qa-manual-edit/${engine}-management-${theme}-${label}.png`,
            });
          }
        }
        await gh.getByRole("button", { name: "Проверить переименование", exact: true }).click();
        await expect(review).toContainText("docs/new.md");
        await expect(review).toContainText("docs/renamed.md");
        await expect(review).toContainText("Оба пути войдут в один коммит");
        for (const theme of ["organizer", "crt-green", "hitech-2000s", "classic-dark"]) {
          await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
          for (const [label, width, height] of [
            ["phone", 390, 844],
            ["keyboard", 390, 460],
            ["tablet", 768, 1024],
            ["wide", 1366, 1024],
          ]) {
            await page.setViewportSize({ width, height });
            await page.screenshot({
              path: `.local/qa-manual-edit/${engine}-rename-${theme}-${label}.png`,
            });
          }
        }
        await finishCommit();
        assert.equal(operation.receipt.input.files.length, 2);
        assert.equal(operation.receipt.input.files[0].content, null);
        assert.equal(operation.receipt.input.files[1].previous, null);
        await gh.getByRole("button", { name: "Удалить", exact: true }).click();
        await expect(review).toContainText("Удаление");
        await expect(review).toContainText("docs/renamed.md");
        await review.getByRole("button", { name: "Отменить изменение", exact: true }).click();
        assert.equal(commits, 3);
        await gh.getByRole("button", { name: "Удалить", exact: true }).click();
        await finishCommit();
        assert.equal(operation.receipt.input.files[0].content, null);
        assert.equal(commits, 4);
        await expect(gh.getByRole("button", { name: "README.md", exact: true })).toBeVisible();
        console.log(
          engine +
            ": create/rename/delete review, cancel, restored editor and no-replay recovery passed",
        );
      }
      if (withPr)
        console.log(
          engine +
            ": branch/commit/PR each dispatched once; reload/drafts/internal PR viewer passed",
        );
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
