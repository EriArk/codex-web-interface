import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, expect, webkit } from "@playwright/test";
import react from "../apps/web/node_modules/@vitejs/plugin-react/dist/index.js";
import { build } from "../apps/web/node_modules/vite/dist/node/index.js";
import { handoffFixture } from "./handoff-fixture.mjs";

const { zipSync, strToU8 } = createRequire(new URL("../apps/hub/package.json", import.meta.url))(
  "fflate",
);
const dir = await mkdtemp(join(tmpdir(), "technical-browser-"));
const cube = await readFile(new URL("./fixtures/technical/cube.stp", import.meta.url));
const iges = await readFile(new URL("./fixtures/technical/cube.igs", import.meta.url));
const stl =
  "solid sample\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 10 0 0\nvertex 0 20 0\nendloop\nendfacet\nfacet normal 1 0 0\nouter loop\nvertex 0 0 0\nvertex 0 20 0\nvertex 0 0 30\nendloop\nendfacet\nendsolid sample";
const binary = Buffer.alloc(84 + 50);
binary.writeUInt32LE(1, 80);
[0, 0, 1, 0, 0, 0, 10, 0, 0, 0, 20, 0].forEach((v, i) => {
  binary.writeFloatLE(v, 84 + i * 4);
});
const dxf =
  "0\nSECTION\n2\nHEADER\n9\n$INSUNITS\n70\n4\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n0\nLINE\n8\nOutline\n10\n0\n20\n0\n11\n100\n21\n70\n0\nCIRCLE\n8\nHole\n10\n50\n20\n30\n40\n20\n0\nARC\n8\nOutline\n10\n50\n20\n30\n40\n30\n50\n0\n51\n180\n0\nTEXT\n8\nOutline\n10\n10\n20\n60\n40\n8\n1\nDrawing 100x70\n0\nENDSEC\n0\nEOF\n";
const meshBuffer = Buffer.from(new Float32Array([0, 0, 0, 10, 0, 0, 0, 20, 0]).buffer);
const gltf = JSON.stringify({
  asset: { version: "2.0" },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ mesh: 0 }],
  meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
  accessors: [
    {
      bufferView: 0,
      componentType: 5126,
      count: 3,
      type: "VEC3",
      min: [0, 0, 0],
      max: [10, 20, 0],
    },
  ],
  bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: meshBuffer.length }],
  buffers: [
    {
      byteLength: meshBuffer.length,
      uri: "data:application/octet-stream;base64," + meshBuffer.toString("base64"),
    },
  ],
});
const glbJson = JSON.parse(gltf);
delete glbJson.buffers[0].uri;
const glbText = Buffer.from(JSON.stringify(glbJson));
const glbAligned = Math.ceil(glbText.length / 4) * 4;
const glb = Buffer.alloc(28 + glbAligned + meshBuffer.length);
glb.writeUInt32LE(0x46546c67, 0);
glb.writeUInt32LE(2, 4);
glb.writeUInt32LE(glb.length, 8);
glb.writeUInt32LE(glbAligned, 12);
glb.writeUInt32LE(0x4e4f534a, 16);
glb.fill(32, 20, 20 + glbAligned);
glbText.copy(glb, 20);
glb.writeUInt32LE(meshBuffer.length, 20 + glbAligned);
glb.writeUInt32LE(0x004e4942, 24 + glbAligned);
meshBuffer.copy(glb, 28 + glbAligned);
const model =
  '<model unit="millimeter"><resources><object id="1"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="10" y="0" z="0"/><vertex x="0" y="20" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object></resources><build><item objectid="1"/></build></model>';
const samples = [
  ["model.step", cube, "model"],
  ["model.igs", iges, "model"],
  ["binary.stl", binary, "model"],
  ["part.stl", Buffer.from(stl), "model"],
  ["part.obj", Buffer.from("v 0 0 0\nv 10 0 0\nv 0 20 0\nf 1 2 3\n"), "model"],
  ["part.gltf", Buffer.from(gltf), "model"],
  ["part.glb", glb, "model"],
  ["part.3mf", Buffer.from(zipSync({ "3D/3dmodel.model": strToU8(model) })), "model"],
  [
    "drawing.dxf",
    Buffer.from(
      dxf.replace(
        "0\nSECTION\n2\nENTITIES",
        "0\nSECTION\n2\nTABLES\n0\nTABLE\n2\nLAYER\n70\n2\n0\nLAYER\n2\nOutline\n70\n0\n62\n7\n6\nCONTINUOUS\n0\nLAYER\n2\nHole\n70\n0\n62\n1\n6\nCONTINUOUS\n0\nENDTAB\n0\nENDSEC\n0\nSECTION\n2\nENTITIES",
      ),
    ),
    "dxf",
  ],
  [
    "hostile.svg",
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="120mm" height="80mm" viewBox="0 0 120 80"><script>parent.compromised=1</script><foreignObject><iframe src="https://bad.invalid"/></foreignObject><image href="https://bad.invalid/x"/><rect x="10" y="10" width="100" height="60" rx="8" fill="#87aabb" onload="alert(1)"/><text x="25" y="45" font-size="9">Safe drawing</text></svg>',
    ),
    "svg",
  ],
  [
    "external.gltf",
    Buffer.from(
      gltf.replace(/data:application\/octet-stream;base64,[^"]+/, "https://bad.invalid/model.bin"),
    ),
    "failure",
  ],
];
if (process.env.OWNER_STEP)
  samples.push([
    "Корпус — исходная передняя панель с длинным названием.step",
    await readFile(process.env.OWNER_STEP),
    "model",
  ]);
await mkdir(".local/qa-technical", { recursive: true });
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
  const origin = "http://127.0.0.1:18857",
    f = await handoffFixture(origin, dir);
  await f.app.listen({ host: "127.0.0.1", port: 18857 });
  try {
    const files = [];
    for (const [name, bytes, kind] of samples) {
      const item = await f.sessions.attachments.put(
        f.store.createThread("project", crypto.randomUUID(), name).id,
        name,
        bytes,
      );
      files.push({ name, kind, url: "/api/attachments/" + item.id });
    }
    for (const [engine, type] of [
      ["chromium", chromium],
      ["webkit", webkit],
    ].filter(([name]) => !process.env.BROWSER || process.env.BROWSER === name)) {
      const browser = await type.launch(
        engine === "chromium"
          ? { args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] }
          : {},
      );
      try {
        const context = await browser.newContext({
          viewport: { width: 1280, height: 800 },
          hasTouch: true,
          serviceWorkers: "block",
        });
        const [name, value] = f.headers.cookie.split("=");
        await context.addCookies([{ name, value, url: origin }]);
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", (e) => errors.push(e.message));
        const outside = [];
        page.on("request", (r) => {
          if (/^https?:/.test(r.url()) && !r.url().startsWith(origin)) outside.push(r.url());
        });
        async function open(file) {
          await page.goto(
            origin +
              "/tests/fixtures/file-popup.html?" +
              new URLSearchParams({ file: file.url, name: file.name }),
          );
          await page.getByRole("textbox", { name: "Draft" }).fill("Private draft remains");
          await page.getByRole("button", { name: "Открыть файл" }).tap();
          await expect(page.getByRole("dialog", { name: "Просмотр файла" })).toBeVisible();
        }
        for (const file of files.filter(
          (file) => !process.env.FORMATS || process.env.FORMATS.split(",").includes(file.name),
        )) {
          await open(file);
          if (file.kind === "model") {
            await expect(page.locator(".technical-status")).toContainText("треугольников", {
              timeout: 60000,
            });
            await expect(page.locator(".technical-canvas canvas")).toBeVisible();
            await page.getByRole("button", { name: "Увеличить", exact: true }).tap();
            await page.getByRole("button", { name: "Сетка", exact: true }).tap();
          }
          if (file.kind === "dxf") {
            await expect(page.locator(".technical-status")).toContainText("mm", { timeout: 30000 });
            await page.getByRole("button", { name: "Измерение" }).tap();
            await expect(page.locator(".dxf-guide")).toHaveCount(4);
            const guide = page.getByRole("slider", { name: "Направляющая X1" });
            const before = await guide.getAttribute("aria-valuenow");
            await guide.focus();
            await page.keyboard.press("ArrowRight");
            assert.notEqual(await guide.getAttribute("aria-valuenow"), before);
            await page.locator("summary").click();
            await expect(page.getByLabel("Outline", { exact: true })).toBeVisible();
            await page.getByLabel("Outline", { exact: true }).uncheck();
            await page.locator("summary").click();
          }
          if (file.kind === "svg") {
            await expect(page.locator(".image-stage img")).toBeVisible();
            await expect(page.locator(".technical-status")).toContainText("исключены");
          }
          if (file.kind === "failure")
            await expect(page.locator(".technical-model")).toContainText("самодостаточный", {
              timeout: 30000,
            });
          assert.equal(outside.length, 0, outside.join("\n"));
          await expect(page.getByRole("link", { name: "Скачать файл", exact: true })).toBeVisible();
          await page.screenshot({
            path: `.local/qa-technical/${engine}-${file.name.replace(/[^a-z0-9.]/gi, "_")}.png`,
          });
          await page.getByRole("button", { name: "Закрыть просмотр" }).tap();
          await expect(page.getByRole("textbox", { name: "Draft" })).toHaveValue(
            "Private draft remains",
          );
          console.log(engine + " format " + file.name + " OK");
        }
        const display = files.find((f) => f.name.startsWith("Корпус")) || files[2];
        for (const theme of process.env.FORMATS
          ? []
          : ["organizer", "crt-green", "hitech-2000s", "classic-dark"])
          for (const [label, width, height] of [
            ["phone", 390, 844],
            ["keyboard", 390, 430],
            ["tablet", 768, 1024],
            ["wide", 1366, 1024],
          ]) {
            await page.setViewportSize({ width, height });
            await open(display);
            await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
            await expect(page.locator(".technical-status")).toContainText("треугольников", {
              timeout: 60000,
            });
            const dialog = page.getByRole("dialog");
            const box = await dialog.boundingBox();
            assert(Math.abs(box.x - (width - box.x - box.width)) < 2, "symmetric gutters");
            for (const control of [
              page.getByRole("button", { name: "Закрыть просмотр" }),
              page.getByRole("link", { name: "Скачать файл", exact: true }),
            ]) {
              const r = await control.boundingBox();
              assert(
                r.y >= 0 && r.y + r.height <= height + 1 && r.x >= 0 && r.x + r.width <= width + 1,
                `${theme}/${label}: reachable controls`,
              );
            }
            assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
            await page.getByRole("button", { name: "Свойства файла" }).tap();
            await expect(page.getByRole("complementary", { name: "Свойства" })).toBeVisible();
            await page.screenshot({ path: `.local/qa-technical/${engine}-${theme}-${label}.png` });
            await page.getByRole("button", { name: "Закрыть просмотр" }).tap();
          }
        assert.deepEqual(errors, []);
        await context.close();
        console.log(engine + " layouts, themes, source bytes and draft continuity OK");
      } finally {
        await browser.close();
      }
    }
  } finally {
    await f.close();
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}
