import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, expect, webkit } from "@playwright/test";
import react from "../apps/web/node_modules/@vitejs/plugin-react/dist/index.js";
import { build } from "../apps/web/node_modules/vite/dist/node/index.js";
import { handoffFixture } from "./handoff-fixture.mjs";

const dir = await mkdtemp(join(tmpdir(), "file-preview-browser-"));
const sharp = createRequire(new URL("../apps/hub/package.json", import.meta.url))("sharp");
const png = await sharp({ create: { width: 240, height: 160, channels: 3, background: "#80b7a1" } })
  .png()
  .toBuffer();
function pdfBytes() {
  const stream = "0.2 0.7 0.4 rg 20 20 160 220 re f";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 260] /Resources << >> /Contents 5 0 R >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 260] /Resources << >> /Contents 5 0 R >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let out = "%PDF-1.4\n";
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const start = out.length;
  out += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((n) => String(n).padStart(10, "0") + " 00000 n \n")
    .join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  return Buffer.from(out);
}
const samples = [
  ["image.png", png, "image"],
  ["pages.pdf", pdfBytes(), "pdf"],
  [
    "notes.md",
    Buffer.from("# Literal heading\n  exact  spaces\n<script>window.compromised=true</script>"),
    "text",
  ],
  ["data.json", Buffer.from('{"a": 1}\n'), "text"],
  ["code.py", Buffer.from('  print("test")\n'), "text"],
  [
    "demo.html",
    Buffer.from(
      '<button onclick="this.textContent=42">Demo</button><script>try {parent.document.body.dataset.compromised=1}catch{};fetch("/api/auth/session").catch(()=>{})</script>',
    ),
    "html",
  ],
  [
    "drawing.svg",
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><circle cx="50" cy="50" r="40" fill="green"/></svg>',
    ),
    "html",
  ],
  ["archive.zip", Buffer.from("PK no inline viewer"), "card"],
  ["broken.pdf", Buffer.from("malformed PDF"), "failed-pdf"],
  ["long.txt", Buffer.from("  exact spaces\n".repeat(7000)), "bounded"],
];
await mkdir(".local/qa-file-preview", { recursive: true });
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
      rolldownOptions: { input: resolve("apps/web/tests/fixtures/file-popup.html") },
    },
  });
  for (const [engine, browserType] of [
    ["chromium", chromium],
    ["webkit", webkit],
  ]) {
    const origin = "http://127.0.0.1:18849",
      f = await handoffFixture(origin, dir),
      browser = await browserType.launch();
    try {
      await f.app.listen({ host: "127.0.0.1", port: 18849 });
      const files = [];
      for (const [name, bytes, kind] of samples) {
        const thread = f.store.createThread("project", randomUUID(), name);
        const attachment = await f.sessions.attachments.put(thread.id, name, bytes);
        files.push({ name, bytes, kind, url: "/api/attachments/" + attachment.id });
        assert.equal((await f.app.inject({ url: files.at(-1).url })).statusCode, 401);
      }
      for (const [layout, viewport] of [
        ["phone", { width: 390, height: 844 }],
        ["landscape", { width: 844, height: 390 }],
        ["tablet", { width: 1366, height: 1024 }],
      ]) {
        const context = await browser.newContext({
          viewport,
          hasTouch: true,
          serviceWorkers: "block",
        });
        const [name, value] = f.headers.cookie.split("=");
        await context.addCookies([{ name, value, url: origin }]);
        await context.addInitScript(() => {
          document.addEventListener("DOMContentLoaded", () => {
            document.documentElement.dataset.theme = "crt-green";
          });
          window.shares = [];
          Object.defineProperty(navigator, "canShare", { value: () => true });
          Object.defineProperty(navigator, "share", {
            value: async ({ files }) => {
              const active = navigator.userActivation.isActive;
              window.shares.push({
                name: files[0].name,
                active,
                bytes: Array.from(new Uint8Array(await files[0].arrayBuffer())),
              });
            },
          });
        });
        const page = await context.newPage();
        for (const file of files) {
          await page.goto(
            origin +
              "/tests/fixtures/file-popup.html?" +
              new URLSearchParams({ file: file.url, name: file.name }),
          );
          await page
            .getByRole("textbox", { name: "Draft" })
            .fill("Keep draft and attachment context");
          await page.locator("main").evaluate((el) => {
            el.scrollTop = 250;
          });
          await page.getByRole("button", { name: "Открыть файл" }).tap();
          const chatScroll = await page.locator("main").evaluate((el) => el.scrollTop);
          const dialog = page.getByRole("dialog", { name: "Просмотр файла" });
          const save = dialog.getByRole("button", { name: "Сохранить / поделиться" });
          await expect(save).toBeVisible();
          if (file.kind === "image")
            await expect
              .poll(() => page.locator(".image-stage img").evaluate((img) => img.naturalWidth))
              .toBe(240);
          if (file.kind === "pdf") {
            await expect(page.getByRole("img", { name: "PDF, страница 1" })).toBeVisible({
              timeout: 20000,
            });
            await expect
              .poll(() =>
                page
                  .locator("canvas")
                  .evaluate(
                    (c) => c.getContext("2d").getImageData(c.width / 2, c.height / 2, 1, 1).data[1],
                  ),
              )
              .toBeGreaterThan(100);
            await page.getByRole("button", { name: "Следующая страница PDF" }).tap();
            await expect(page.getByRole("img", { name: "PDF, страница 2" })).toBeVisible();
          }
          if (file.name.endsWith(".md"))
            await page.getByRole("button", { name: "Исходный текст" }).tap();
          if (file.kind === "text")
            await expect(page.locator(".file-text")).toHaveText(file.bytes.toString());
          if (file.kind === "bounded") {
            await expect(page.locator(".file-text")).toHaveText(
              file.bytes.toString().slice(0, 65536),
            );
            await expect(dialog).toContainText("Показано начало файла");
          }
          if (file.name.endsWith(".svg"))
            await expect(page.locator(".image-stage img")).toBeVisible();
          if (file.kind === "html" && !file.name.endsWith(".svg")) {
            await expect(page.locator("iframe.file-html")).toBeVisible();
            assert.equal(
              await page.locator("iframe.file-html").getAttribute("sandbox"),
              "allow-scripts",
            );
            if (file.name.endsWith("html")) {
              await page
                .frameLocator("iframe.file-html")
                .getByRole("button", { name: "Demo" })
                .tap();
              await expect(
                page.frameLocator("iframe.file-html").getByRole("button", { name: "42" }),
              ).toBeVisible();
            } else await expect(page.frameLocator("iframe.file-html").locator("svg")).toBeVisible();
          }
          if (file.kind === "card")
            await expect(page.locator(".file-type-card")).toContainText("ZIP");
          if (file.kind === "failed-pdf")
            await expect(page.locator(".file-preview-fallback")).toBeVisible({ timeout: 20000 });
          assert.equal(
            await page.evaluate(() => !!window.compromised || !!document.body.dataset.compromised),
            false,
          );
          for (const control of [save, dialog.getByRole("button", { name: "Закрыть просмотр" })]) {
            const rect = await control.boundingBox();
            assert(
              rect.x >= 0 &&
                rect.y >= 0 &&
                rect.x + rect.width <= viewport.width + 1 &&
                rect.y + rect.height <= viewport.height + 1,
              `${engine}/${layout}/${file.name} control outside viewport`,
            );
          }
          assert.equal(await page.evaluate(() => window.shares.length), 0);
          await save.tap();
          await expect.poll(() => page.evaluate(() => window.shares.length)).toBe(1);
          const shared = await page.evaluate(() => window.shares[0]);
          assert.equal(shared.name, file.name);
          assert.equal(shared.active, true);
          assert.deepEqual(Buffer.from(shared.bytes), file.bytes);
          if (["pdf", "text", "html"].includes(file.kind))
            await page.screenshot({
              path: `.local/qa-file-preview/${engine}-${layout}-${file.name}.png`,
            });
          await dialog.getByRole("button", { name: "Закрыть просмотр" }).tap();
          await expect(dialog).toHaveCount(0);
          assert.equal(await page.locator("main").evaluate((el) => el.scrollTop), chatScroll);
          await expect(page.getByRole("textbox", { name: "Draft" })).toHaveValue(
            "Keep draft and attachment context",
          );
        }
        // A failed optional preview does not disable the already prepared original file.
        const html = files.find((file) => file.name === "demo.html");
        await page.route("**/api/previews/file", (route) =>
          route.fulfill({
            status: 503,
            contentType: "application/json",
            body: '{"error":{"message":"Unavailable"}}',
          }),
        );
        await page.goto(
          origin +
            "/tests/fixtures/file-popup.html?" +
            new URLSearchParams({ file: html.url, name: html.name }),
        );
        await page.getByRole("button", { name: "Открыть файл" }).tap();
        await expect(page.locator(".file-type-card")).toBeVisible();
        await page.getByRole("button", { name: "Сохранить / поделиться" }).tap();
        await expect.poll(() => page.evaluate(() => window.shares.length)).toBe(1);
        await context.close();
        console.log(
          engine +
            " " +
            layout +
            ": file previews, sandbox, original bytes, fresh share, close/draft OK",
        );
      }
    } finally {
      await browser.close();
      await f.close();
    }
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}
