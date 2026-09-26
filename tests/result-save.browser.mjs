import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, expect, webkit } from "@playwright/test";
import react from "../apps/web/node_modules/@vitejs/plugin-react/dist/index.js";
import { build } from "../apps/web/node_modules/vite/dist/node/index.js";
import { zip } from "./package-fixtures.mjs";
import { handoffFixture } from "./handoff-fixture.mjs";

const archive = zip({ "entry.md": "# Archive entry\n" });
const dir = await mkdtemp(join(tmpdir(), "result-save-"));
await mkdir(".local/qa-result-save", { recursive: true });
try {
  await build({
    configFile: false,
    root: resolve("apps/web"),
    plugins: [react()],
    logLevel: "error",
    build: {
      target: "esnext",
      outDir: dir,
      emptyOutDir: true,
      rolldownOptions: { input: resolve("apps/web/tests/fixtures/result-save.html") },
    },
  });
  const origin = "http://127.0.0.1:18874",
    fixture = await handoffFixture(origin, dir);
  await fixture.app.listen({ host: "127.0.0.1", port: 18874 });
  try {
    for (const [engine, type] of [
      ["chromium", chromium],
      ["webkit", webkit],
    ].filter(([name]) => !process.env.BROWSER || process.env.BROWSER === name)) {
      const browser = await type.launch();
      try {
        const context = await browser.newContext({
          viewport: { width: 390, height: 844 },
          hasTouch: true,
        });
        const [name, value] = fixture.headers.cookie.split("=");
        await context.addCookies([{ name, value, url: origin }]);
        const page = await context.newPage(),
          errors = [];
        page.on("pageerror", (e) => errors.push(e.message));
        let failed = false,
          slow = false;
        await page.route("**/api/artifacts/image*", async (route) => {
          if (slow) await new Promise((resolve) => setTimeout(resolve, 600));
          await route.fulfill({
            status: failed ? 503 : 200,
            headers: {
              "content-type": "image/png",
              "content-disposition": "attachment; filename=shops-installed-stock.png",
            },
            body: Buffer.from(
              "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aU1sAAAAASUVORK5CYII=",
              "base64",
            ),
          });
        });
        await page.route("**/api/artifacts/zip", (route) =>
          route.fulfill({
            headers: {
              "content-type": "application/zip",
              "content-disposition": 'attachment; filename="diagnostics.zip"',
            },
            body: archive,
          }),
        );
        await page.route("**/api/team/brainstorm-conversions/room-export/export", (route) =>
          route.fulfill({ headers: { "content-type": "application/zip" }, body: archive }),
        );
        await page.addInitScript(() => {
          window.shared = [];
          window.shareMode = "cancel";
          Object.defineProperty(navigator, "standalone", { configurable: true, value: true });
          Object.defineProperty(navigator, "canShare", { configurable: true, value: () => true });
          Object.defineProperty(navigator, "share", {
            configurable: true,
            value: async ({ files }) => {
              if (window.shareMode === "cancel") throw new DOMException("Cancel", "AbortError");
              if (window.shareMode === "fail") throw new DOMException("Failure", "NotAllowedError");
              window.shared.push({
                name: files[0].name,
                type: files[0].type,
                active: navigator.userActivation.isActive,
                bytes: Array.from(new Uint8Array(await files[0].arrayBuffer())),
              });
            },
          });
        });
        await page.goto(origin + "/tests/fixtures/result-save.html");
        await page.evaluate(async () => {
          await document.fonts.ready;
          await Promise.all(
            Array.from(document.images, (image) => {
              image.loading = "eager";
              return image.decode().catch(() => {});
            }),
          );
        });
        const initial = page.url();
        const source = page.getByRole("button", { name: "Скачать", exact: true }).nth(4);
        await source.scrollIntoViewIfNeeded();
        const scroll = await page
          .locator(".results-pane .pane-scroll")
          .evaluate((el) => el.scrollTop);
        failed = true;
        await source.tap();
        const dialog = page.getByRole("dialog", { name: "Сохранить файл" });
        const close = dialog.getByRole("button", { name: "Закрыть сохранение" });
        await expect(dialog.getByRole("alert")).toBeVisible();
        failed = false;
        slow = true;
        await dialog.getByRole("button", { name: "Повторить" }).tap();
        await expect(dialog.getByRole("status")).toBeVisible();
        await close.tap();
        await expect(dialog).toHaveCount(0);
        await expect(source).toBeFocused();
        slow = false;
        await source.tap();
        const share = dialog.getByRole("button", { name: "Сохранить / поделиться" });
        await expect(share).toBeEnabled();
        await share.tap();
        await expect(share).toBeEnabled();
        await expect(dialog.getByRole("alert")).toHaveCount(0);
        await page.evaluate(() => (window.shareMode = "fail"));
        await share.tap();
        await expect(dialog.getByRole("alert")).toContainText("Не удалось открыть");
        await page.evaluate(() => (window.shareMode = "ok"));
        await share.tap();
        await expect.poll(() => page.evaluate(() => window.shared.length)).toBe(1);
        const saved = await page.evaluate(() => window.shared[0]);
        assert.equal(saved.name, "shops-installed-stock.png");
        assert.equal(saved.type, "image/png");
        assert.equal(saved.active, true);
        assert.equal(saved.bytes.length, 68);
        await close.tap();
        await expect(source).toBeFocused();
        assert.equal(page.url(), initial);
        assert.equal(context.pages().length, 1);
        assert.equal(
          await page.locator(".results-pane .pane-scroll").evaluate((el) => el.scrollTop),
          scroll,
        );
        await expect(page.getByRole("textbox", { name: "Черновик" })).toHaveValue("Мой черновик");
        for (const theme of ["organizer", "crt-green", "hitech-2000s", "classic-dark"]) {
          await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
          for (const [layout, viewport] of [
            ["phone", { width: 390, height: 844 }],
            ["keyboard", { width: 390, height: 430 }],
            ["wide", { width: 1366, height: 1024 }],
          ]) {
            await page.setViewportSize(viewport);
            await source.tap();
            await expect(share).toBeEnabled();
            await expect(close).toBeInViewport();
            assert((await dialog.boundingBox()).height < 300);
            await page.screenshot({
              path: `.local/qa-result-save/${engine}-${theme}-${layout}.png`,
            });
            await close.tap();
          }
        }
        // The actual universal viewer used by chat references previously bypassed safe saving.
        for (const [entry, action, parentClose, filename, bytes] of [
          ["Открыть ZIP результата", "Скачать файл", "Закрыть просмотр", "diagnostics.zip", null],
          [
            "Открыть черновик",
            "Скачать черновик",
            "Закрыть просмотр",
            "edited.md",
            "# Saved draft\n",
          ],
          [
            "Открыть копию",
            "Скачать копию",
            "Закрыть сохранение копии",
            "edited.md",
            "# Saved draft\n",
          ],
        ]) {
          await page.getByRole("button", { name: entry, exact: true }).click();
          await page.getByRole("button", { name: action, exact: true }).click();
          await expect(share).toBeEnabled();
          await expect(close).toBeInViewport();
          await share.click();
          await expect.poll(() => page.evaluate(() => window.shared.at(-1)?.name)).toBe(filename);
          assert.deepEqual(
            await page.evaluate(() => window.shared.at(-1).bytes),
            Array.from(filename === "diagnostics.zip" ? archive : Buffer.from(bytes)),
          );
          assert.equal(await page.evaluate(() => window.shared.at(-1).active), true);
          await close.click();
          await expect(page.getByRole("button", { name: action, exact: true })).toBeVisible();
          await page.getByRole("button", { name: parentClose, exact: true }).click();
          assert.equal(page.url(), initial);
          assert.equal(context.pages().length, 1);
          await expect(page.getByRole("textbox", { name: "Черновик" })).toHaveValue("Мой черновик");
        }
        await page.getByRole("button", { name: "Локальный ZIP", exact: true }).click();
        await share.click();
        await expect
          .poll(() => page.evaluate(() => window.shared.at(-1)?.name))
          .toBe("installer.zip");
        await close.click();
        await page.getByRole("button", { name: "Архив комнаты", exact: true }).click();
        await share.click();
        await expect
          .poll(() => page.evaluate(() => window.shared.at(-1).bytes))
          .toEqual(Array.from(archive));
        await close.click();
        await page.getByRole("button", { name: "Открыть ZIP результата", exact: true }).click();
        await page.getByRole("button", { name: /entry.md/ }).click();
        await expect(page.locator("dialog[open]")).toHaveCount(2);
        await page
          .locator("dialog[open]")
          .last()
          .getByRole("button", { name: "Скачать", exact: true })
          .click();
        await share.click();
        await expect.poll(() => page.evaluate(() => window.shared.at(-1)?.name)).toBe("entry.md");
        assert.deepEqual(
          await page.evaluate(() => window.shared.at(-1).bytes),
          Array.from(Buffer.from("# Archive entry\n")),
        );
        await close.click();
        await page.getByRole("button", { name: "Закрыть просмотр", exact: true }).last().click();
        await expect(page.getByRole("button", { name: /entry.md/ })).toBeVisible();
        await page.getByRole("button", { name: "Закрыть просмотр", exact: true }).click();
        // Standalone fallback deliberately avoids the download attribute that iOS can
        // consume in the app's own window despite target=_blank.
        await page.evaluate(() =>
          Object.defineProperty(navigator, "canShare", { configurable: true, value: () => false }),
        );
        await source.tap();
        const fallback = dialog.getByRole("link", { name: "Скачать через браузер" });
        await expect(fallback).toBeVisible();
        await expect(fallback).not.toHaveAttribute("download");
        await expect(fallback).toHaveAttribute("target", "_blank");
        await close.click();
        // Desktop without file sharing retains direct browser downloads.
        await page.evaluate(() => {
          Object.defineProperty(navigator, "standalone", { configurable: true, value: false });
          Object.defineProperty(navigator, "share", { configurable: true, value: undefined });
          Object.defineProperty(navigator, "canShare", { configurable: true, value: undefined });
        });
        await source.tap(); // Triggers a render, which switches to the browser download branch.
        const link = page
          .locator('[data-result="image4"]')
          .getByRole("link", { name: "Скачать", exact: true });
        await expect(link).toHaveAttribute("download", "shops-installed-stock.png");
        await expect(link).toHaveAttribute("target", "_blank");
        await expect(link).toHaveAttribute("href", /\/api\/artifacts\/image4/);
        assert.equal(page.url(), initial);
        assert.deepEqual(errors, []);
        await context.close();
        console.log(engine + " result save browser passed");
      } finally {
        await browser.close();
      }
    }
  } finally {
    await fixture.close();
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}
