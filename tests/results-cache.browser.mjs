import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, expect, webkit } from "@playwright/test";
import react from "../apps/web/node_modules/@vitejs/plugin-react/dist/index.js";
import { build } from "../apps/web/node_modules/vite/dist/node/index.js";

const dir = await mkdtemp(join(tmpdir(), "results-cache-"));
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
        entry: resolve("apps/web/tests/fixtures/results-cache.tsx"),
        name: "ResultsCache",
        formats: ["iife"],
        fileName: () => "fixture.js",
      },
    },
  });
  const js = await readFile(join(dir, "fixture.js"), "utf8");
  for (const [name, type] of [
    ["chromium", chromium],
    ["webkit", webkit],
  ]) {
    const browser = await type.launch();
    const pending = [];
    try {
      const page = await browser.newPage();
      let cachedReads = 0,
        fileReads = 0,
        holdAll = false;
      const data = (title, lineage) => ({
        items: [
          {
            id: title,
            type: "file",
            title,
            createdAt: new Date(0).toISOString(),
            payload: { url: "/api/gpt/results/large-file", mime: "application/zip" },
          },
        ],
        nextBefore: null,
        sourceRevision: lineage,
        counts: { all: 1, files: 1, images: 0, demos: 0, links: 0, work: 0, reasoning: 0 },
      });
      await page.route("https://cache.test/**", async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname === "/")
          return route.fulfill({
            contentType: "text/html",
            body: '<div id="root"></div><script src="/fixture.js"></script>',
          });
        if (url.pathname === "/fixture.js")
          return route.fulfill({ contentType: "application/javascript", body: js });
        if (url.pathname === "/api/gpt/results/large-file") {
          fileReads++;
          return route.fulfill({ body: "unexpected" });
        }
        if (url.pathname.endsWith("/a/results")) {
          if (url.searchParams.has("cached")) {
            cachedReads++;
            if (!holdAll) return route.fulfill({ json: data("Saved archive", 1) });
          }
          await new Promise((resolve) =>
            pending.push(async () => {
              await route.fulfill({ json: data("Fresh archive", 2) });
              resolve();
            }),
          );
          return;
        }
        return route.fulfill({ json: data("Other chat archive", 1) });
      });
      await page.goto("https://cache.test/");
      await expect(page.getByRole("heading", { name: "Saved archive", exact: true })).toBeVisible();
      await expect.poll(() => pending.length).toBe(1);
      await pending.shift()();
      await expect(page.getByRole("heading", { name: "Fresh archive", exact: true })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Saved archive", exact: true })).toHaveCount(
        0,
      );
      await page.getByRole("button", { name: "Chat b", exact: true }).click();
      await expect(
        page.getByRole("heading", { name: "Other chat archive", exact: true }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Chat a", exact: true }).click();
      await expect.poll(() => pending.length).toBe(1);
      await expect(page.getByRole("heading", { name: "Fresh archive", exact: true })).toBeVisible();
      assert.equal(cachedReads, 1, "return uses browser metadata while canonical read is pending");
      holdAll = true;
      await page.getByRole("button", { name: "Logout", exact: true }).click();
      await pending.shift()(); // A late response must not repopulate the cleared cache.
      await page.getByRole("button", { name: "Chat a", exact: true }).click();
      await expect.poll(() => cachedReads).toBe(2);
      await expect(page.getByRole("heading", { name: "Fresh archive", exact: true })).toHaveCount(
        0,
      );
      assert.equal(fileReads, 0, "navigation must not download files");
      console.log(
        `${name}: cached metadata is immediate, canonical branch replaces it, scopes/logout isolate cache, no file downloads`,
      );
    } finally {
      await browser.close();
    }
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}
