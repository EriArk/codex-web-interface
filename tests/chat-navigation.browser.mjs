import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, expect, webkit } from "@playwright/test";
import react from "../apps/web/node_modules/@vitejs/plugin-react/dist/index.js";
import { build } from "../apps/web/node_modules/vite/dist/node/index.js";

const dir = await mkdtemp(join(tmpdir(), "chat-navigation-"));
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
        entry: resolve("apps/web/tests/fixtures/chat-navigation.tsx"),
        name: "ChatNavigationFixture",
        formats: ["iife"],
        fileName: () => "fixture.js",
      },
    },
  });
  const js = await readFile(join(dir, "fixture.js"), "utf8");
  const css = (
    await Promise.all(
      (await readdir(dir))
        .filter((file) => file.endsWith(".css"))
        .map((file) => readFile(join(dir, file), "utf8")),
    )
  ).join("\n");

  for (const [engine, type] of [
    ["chromium", chromium],
    ["webkit", webkit],
  ]) {
    const browser = await type.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.route("https://chat-nav.test/**", (route) =>
        route.fulfill({
          contentType: "text/html",
          body:
            '<!doctype html><meta charset="utf-8"><div id="root"></div><style>' +
            css +
            "</style><script>" +
            js +
            "</script>",
        }),
      );
      await page.goto("https://chat-nav.test");

      const scroller = page.getByTestId("scroller");
      const top = (id) =>
        scroller.evaluate(
          (el, message) =>
            el.querySelector(`[data-message="${message}"]`)?.getBoundingClientRect().top -
            el.getBoundingClientRect().top,
          id,
        );

      await page.locator('[data-message="m3"]').evaluate((el) =>
        el.scrollIntoView({ block: "start" }),
      );
      await page.getByRole("button", { name: "Предыдущее сообщение" }).click();
      await expect.poll(() => top("m2")).toBeGreaterThanOrEqual(-1);
      await expect.poll(() => top("m2")).toBeLessThan(12);

      // The hidden/internal row is not a navigation stop. At the first loaded
      // public message, Previous loads older canonical history and lands on m1.
      await page.getByRole("button", { name: "Предыдущее сообщение" }).click();
      await expect(page.getByTestId("older-calls")).toHaveText("1");
      await expect.poll(() => top("m1")).toBeGreaterThanOrEqual(-1);
      await expect.poll(() => top("m1")).toBeLessThan(12);

      await page.getByRole("button", { name: "Следующее сообщение" }).click();
      await expect.poll(() => top("m2")).toBeGreaterThanOrEqual(-1);
      await expect.poll(() => top("m2")).toBeLessThan(12);
      await page.getByRole("button", { name: "Следующее сообщение" }).click();
      await expect.poll(() => top("m3")).toBeGreaterThanOrEqual(-1);
      await page.getByRole("button", { name: "Предыдущее сообщение" }).click();
      await expect.poll(() => top("m2")).toBeGreaterThanOrEqual(-1);

      await page.getByRole("button", { name: "Fragment", exact: true }).click();
      await expect(page.getByTestId("newer-calls")).toHaveText("0");
      await page.getByRole("button", { name: "Следующее сообщение" }).click();
      await expect.poll(() => top("m3")).toBeGreaterThanOrEqual(-1);
      await expect(page.getByRole("button", { name: "Следующее сообщение" })).toBeDisabled();
      await expect(page.getByTestId("newer-calls")).toHaveText("0");
      await page.getByRole("button", { name: "В конец чата" }).click();
      await expect(page.getByTestId("newer-calls")).toHaveText("1");
      await expect.poll(() =>
        scroller.evaluate(
          (el) => Math.abs(el.scrollHeight - el.scrollTop - el.clientHeight),
        ),
      ).toBeLessThan(2);

      await expect(page.getByRole("textbox", { name: "Draft" })).toHaveValue("Keep draft");
      await expect(page.getByTestId("attachment")).toHaveText("report.txt");
      await expect(page.getByRole("button", { name: "В конец чата" })).toBeDisabled();

      const widthBefore = await scroller.evaluate((el) => el.clientWidth);
      for (const width of [390, 1024, 1280]) {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 800 });
        const controls = page.getByRole("navigation", { name: "Навигация по сообщениям" });
        await expect(controls).toBeVisible();
        const box = await controls.boundingBox();
        assert(box && box.x >= 0 && box.x + box.width <= width);
        assert.equal(await scroller.evaluate((el) => el.clientWidth), widthBefore);
      }
      assert.deepEqual(errors, []);
      console.log(
        engine +
          ": previous/next public messages, older paging, canonical latest and draft preservation passed",
      );
    } finally {
      await browser.close();
    }
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}
