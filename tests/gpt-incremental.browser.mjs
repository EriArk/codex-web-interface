import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, expect, webkit } from "@playwright/test";
import { GptHistoryCache } from "../apps/hub/dist/gpt-cache.js";
import { GptResultIndex } from "../apps/hub/dist/gpt-result-index.js";
import react from "../apps/web/node_modules/@vitejs/plugin-react/dist/index.js";
import { build } from "../apps/web/node_modules/vite/dist/node/index.js";

const dir = await mkdtemp(join(tmpdir(), "gpt-incremental-"));
try {
  await build({
    configFile: false,
    root: resolve("apps/web"),
    plugins: [react()],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    logLevel: "error",
    build: {
      outDir: dir,
      emptyOutDir: true,
      lib: {
        entry: resolve("apps/web/tests/fixtures/gpt-incremental.tsx"),
        name: "Incremental",
        formats: ["iife"],
        fileName: () => "fixture.js",
      },
    },
  });
  const js = await readFile(join(dir, "fixture.js"), "utf8");
  const css = (
    await Promise.all(
      (
        await readdir(dir)
      )
        .filter((p) => p.endsWith(".css"))
        .map((p) => readFile(join(dir, p), "utf8")),
    )
  ).join("\n");
  for (const [name, type] of [
    ["chromium", chromium],
    ["webkit", webkit],
  ]) {
    const browser = await type.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      let list = Array.from({ length: 60 }, (_, i) => ({
        id: `m${i}`,
        role: i % 2 ? "assistant" : "user",
        text: `Message ${i}`,
        createdAt: i + 1,
        complete: true,
        files:
          i % 2
            ? [
                {
                  id: `f${i}`,
                  name: `File ${i}`,
                  url: `/api/gpt/files/f${i}`,
                  mime: "text/plain",
                  bytes: 10,
                  image: false,
                },
              ]
            : [],
      }));
      const cache = new GptHistoryCache(async () => list);
      list[59].files.push({
        id: "picture",
        name: "Preview",
        url: "/picture.png",
        mime: "image/png",
        bytes: 68,
        image: true,
      });
      let index = new GptResultIndex("incremental", { inline: () => null });
      const sync = () => {
        const s = cache.seed("incremental", list);
        index.update(s.items);
        return s;
      };
      sync();
      const replies = [];
      let writes = 0,
        imageReads = 0;
      await page.route("https://incremental.test/**", async (route) => {
        const url = new URL(route.request().url()),
          path = url.pathname;
        if (path === "/")
          return route.fulfill({
            contentType: "text/html",
            body: '<!doctype html><meta charset="utf-8"><div id="root"></div><link rel="stylesheet" href="/fixture.css"><script src="/fixture.js"></script>',
          });
        if (path === "/fixture.js")
          return route.fulfill({ contentType: "application/javascript", body: js });
        if (path === "/fixture.css") return route.fulfill({ contentType: "text/css", body: css });
        if (path === "/picture.png") {
          imageReads++;
          return route.fulfill({
            contentType: "image/png",
            body: Buffer.from(
              "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=",
              "base64",
            ),
          });
        }
        if (route.request().method() !== "GET") writes++;
        let data;
        if (path.endsWith("/messages"))
          data = await cache.page("incremental", Object.fromEntries(url.searchParams));
        else if (path.endsWith("/results"))
          data = {
            ...index.page(
              url.searchParams.get("category") || "all",
              url.searchParams.get("before") || undefined,
              url.searchParams.get("known") || undefined,
            ),
            sourceRevision: (await cache.snapshot("incremental")).lineage,
          };
        else return route.fulfill({ status: 404, body: "missing" });
        replies.push({ path, data });
        await route.fulfill({ json: data });
      });
      await page.goto("https://incremental.test/");
      await expect(page.locator("[data-message]")).toHaveCount(20);
      await expect(page.locator("[data-result]")).toHaveCount(20);
      await page.getByRole("button", { name: "Older messages", exact: true }).click();
      await expect(page.locator("[data-message]")).toHaveCount(40);
      await page.locator(".load-more").click();
      await expect(page.locator("[data-result]")).toHaveCount(30);
      await page.getByLabel("Draft").fill("Keep my draft");
      await page.evaluate(() => {
        window.savedMessage = document.querySelector('[data-message="m30"]');
        window.savedCard = document.querySelector('[data-result="f39"]');
        const history = document.querySelector('[data-testid="history"]');
        history.scrollTop = 250;
        history.dispatchEvent(new Event("scroll"));
      });
      const scroll = await page.getByTestId("history").evaluate((el) => el.scrollTop);
      list = [
        ...list,
        { id: "new-user", role: "user", text: "Next", files: [], createdAt: 61 },
        {
          id: "new-answer",
          role: "assistant",
          text: "New answer",
          files: [{ ...list[59].files[0], id: "new-file", name: "New file" }],
          createdAt: 62,
        },
      ];
      sync();
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
      await expect(page.locator("[data-message]")).toHaveCount(42);
      await expect(page.locator("[data-result]")).toHaveCount(31);
      assert.ok(
        replies.some(
          (r) => r.path.endsWith("/messages") && r.data.delta && r.data.items.length === 2,
        ),
      );
      assert.ok(
        replies.some(
          (r) => r.path.endsWith("/results") && r.data.delta && r.data.items.length === 1,
        ),
      );
      assert.equal(await page.getByTestId("history").evaluate((el) => el.scrollTop), scroll);
      assert.equal(
        await page.evaluate(
          () =>
            window.savedMessage === document.querySelector('[data-message="m30"]') &&
            window.savedCard === document.querySelector('[data-result="f39"]'),
        ),
        true,
      );
      await expect(page.getByLabel("Draft")).toHaveValue("Keep my draft");
      await page.getByRole("button", { name: /^Изображения/ }).click();
      const picture = page.locator('[data-result="picture"] img');
      await expect(picture).toBeVisible();
      await expect.poll(() => imageReads).toBe(1);
      await picture.evaluate((el) => {
        window.savedImage = el;
      });
      list = list.map((m) => (m.id === "new-answer" ? { ...m, text: "Changed answer" } : m));
      sync();
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
      await expect(page.locator('[data-message="new-answer"]')).toHaveText("Changed answer");
      await expect.poll(() => replies.at(-1)?.path.endsWith("/results")).toBe(true);
      assert.equal(await picture.evaluate((el) => el === window.savedImage), true);
      assert.equal(imageReads, 1);
      await page.getByRole("button", { name: /^Файлы/ }).click();
      await expect(page.locator("[data-result]")).toHaveCount(20);
      // Native branch replacement removes old cards and never appends stale history.
      list = [
        { id: "branch-user", role: "user", text: "Branch", files: [], createdAt: 1 },
        {
          id: "branch-answer",
          role: "assistant",
          text: "Branch answer",
          files: [{ ...list[59].files[0], id: "branch-file" }],
          createdAt: 2,
        },
      ];
      sync();
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
      await expect(page.locator("[data-message]")).toHaveCount(2);
      await expect(page.locator("[data-result]")).toHaveCount(1);
      await expect(page.locator('[data-result="branch-file"]')).toHaveCount(1);
      // A rebuilt projection has no delta journal: exact known revision still works, edits reset.
      index = new GptResultIndex("incremental", { inline: () => null });
      sync();
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
      await expect(page.getByTestId("busy")).toHaveText("false");
      await expect(page.getByTestId("error")).toBeEmpty();
      assert.deepEqual(errors, []);
      assert.equal(writes, 0);
      console.log(
        `${name}: incremental history/results, older pages, DOM identity, scroll, draft, branch replacement and read-only refresh passed.`,
      );
    } finally {
      await browser.close();
    }
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}
