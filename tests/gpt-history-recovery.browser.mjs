import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, expect, webkit } from "@playwright/test";
import react from "../apps/web/node_modules/@vitejs/plugin-react/dist/index.js";
import { build } from "../apps/web/node_modules/vite/dist/node/index.js";

const dir = await mkdtemp(join(tmpdir(), "gpt-history-recovery-"));
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
        entry: resolve("apps/web/tests/fixtures/gpt-history-recovery.tsx"),
        name: "HistoryRecovery",
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
    try {
      const page = await browser.newPage();
      const base = Date.now();
      await page.clock.install({ time: base });
      let mode = "healthy",
        reads = 0,
        writes = 0;
      await page.route("https://history.test/**", async (r) => {
        const path = new URL(r.request().url()).pathname;
        if (path === "/fixture.js")
          return r.fulfill({ contentType: "application/javascript", body: js });
        if (path === "/")
          return r.fulfill({
            contentType: "text/html",
            body: '<div id="root"></div><script src="/fixture.js"></script>',
          });
        if (r.request().method() !== "GET") writes++;
        reads++;
        if (mode === "denied" || mode === "transport")
          return r.fulfill({
            status: mode === "denied" ? 403 : 503,
            json: {
              error: {
                code: mode === "denied" ? "FORBIDDEN" : "GPT_CONNECTION_LOST",
                message: mode,
              },
            },
          });
        return r.fulfill({
          json: {
            items: [
              { id: "reply", role: "assistant", text: "Saved reply", createdAt: 1, complete: true },
            ],
            revision: "v1",
            nextBefore: null,
            ...(mode === "stale"
              ? { stale: true, refreshMessage: "History temporarily unavailable" }
              : {}),
          },
        });
      });
      await page.goto("https://history.test/");
      await expect(page.getByText("Saved reply", { exact: true })).toBeVisible();
      await page.getByLabel("Draft").fill("Keep this draft");
      const refresh = async () => {
        const before = reads;
        await page.getByText("Refresh", { exact: true }).click();
        await expect.poll(() => reads).toBe(before + 1);
        await expect(page.getByTestId("busy")).toHaveText("false");
      };
      mode = "stale";
      await refresh();
      await expect(page.getByTestId("error")).toBeEmpty();
      await expect(page.getByTestId("stale")).toHaveText("true");
      await page.clock.setSystemTime(base + 15000);
      await refresh();
      await expect(page.getByTestId("error")).toBeEmpty();
      await page.clock.setSystemTime(base + 31000);
      await refresh();
      await expect(page.getByTestId("error")).toHaveText("History temporarily unavailable");
      mode = "healthy";
      await refresh();
      await expect(page.getByTestId("error")).toBeEmpty();
      mode = "transport";
      // Exercise the periodic effect's catch too: it must not overwrite quiet handling.
      await page.clock.fastForward(15000);
      await expect(page.getByTestId("busy")).toHaveText("false");
      await expect(page.getByTestId("error")).toBeEmpty();
      mode = "denied";
      await refresh();
      await expect(page.getByTestId("error")).toHaveText("denied");
      await expect(page.getByText("Saved reply", { exact: true })).toBeVisible();
      await expect(page.getByLabel("Draft")).toHaveValue("Keep this draft");
      assert.equal(writes, 0);
      console.log(
        name +
          ": transient history quietly recovers; prolonged/access failures visible; saved text/draft retained; no writes",
      );
    } finally {
      await browser.close();
    }
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}
