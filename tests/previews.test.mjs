import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Previews, previewCsp, previewSources } from "../apps/hub/dist/previews.js";
import { Store } from "../apps/hub/dist/store.js";
import {
  PREVIEW_LIMIT,
  previewPath,
  readMachinePreview,
} from "../packages/machines/dist/preview.js";

const windows = { type: "ssh-windows" },
  linux = { type: "local-linux" };
test("preview file reads stay inside the project and reject symlinks, traversal and oversized files", async () => {
  assert.equal(
    previewPath(windows, "D:\\Projects\\TrainerOs", "work/visuals/demo.html"),
    "D:\\Projects\\TrainerOs\\work\\visuals\\demo.html",
  );
  assert.equal(
    previewPath(windows, "D:\\Projects\\TrainerOs", "/D:/Projects/TrainerOs/demo.html"),
    "D:\\Projects\\TrainerOs\\demo.html",
  );
  for (const path of [
    "../secret.html",
    "D:\\Other\\secret.html",
    "D:\\Projects\\TrainerOs-other\\x.html",
    "\\\\server\\share\\x.html",
    "demo.html:stream",
    "https://example.com/demo.html",
  ])
    assert.throws(() => previewPath(windows, "D:\\Projects\\TrainerOs", path), {
      code: "INVALID_PREVIEW_PATH",
    });
  const root = await mkdtemp(join(tmpdir(), "codex-preview-"));
  try {
    await mkdir(join(root, "project"));
    await writeFile(join(root, "outside.html"), "<p>private</p>");
    await symlink(join(root, "outside.html"), join(root, "project", "escape.html"));
    await assert.rejects(readMachinePreview(linux, join(root, "project"), "escape.html"), {
      code: "INVALID_PREVIEW_PATH",
    });
    await writeFile(join(root, "project", "demo.html"), "<button>Tap me</button>");
    assert.equal(
      (await readMachinePreview(linux, join(root, "project"), "demo.html")).toString(),
      "<button>Tap me</button>",
    );
    await writeFile(join(root, "project", "large.html"), Buffer.alloc(PREVIEW_LIMIT + 1));
    await assert.rejects(readMachinePreview(linux, join(root, "project"), "large.html"), {
      code: "INVALID_PREVIEW_PATH",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("native HTML blocks, local links and file changes become stable isolated result cards", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-preview-store-")),
    store = new Store(":memory:");
  try {
    const thread = store.createThread("p", "native", "Demo");
    const previews = new Previews(join(root, "saved"), store, () => ({ machine: linux, root }));
    const fence = String.fromCharCode(96).repeat(3);
    const item = {
      id: "answer",
      type: "agentMessage",
      text:
        fence +
        "html\n<div><button onclick=\"this.textContent='Done'\">Go</button></div>\n" +
        fence +
        "\n[Demo](design.html)\n[external](https://example.com/a.html)",
    };
    assert.equal(previewSources(item).length, 2);
    assert.equal(
      previewSources({
        type: "mcpToolCall",
        result: {
          content: [
            { type: "resource", resource: { mimeType: "text/html", text: "<main>Demo</main>" } },
            { type: "text", text: "private tool output" },
          ],
        },
      }).length,
      1,
    );

    assert.equal(previews.observe(thread, "turn", item).length, 2);
    assert.equal(previews.observe(thread, "turn", item).length, 0);
    await writeFile(join(root, "design.html"), "<main>Original demo</main>");
    const rows = store.db.prepare("SELECT * FROM html_previews").all();
    for (const row of rows) {
      const html = await previews.document(row.id);
      assert(html.includes("viewport"));
      assert(html.includes("button") || html.includes("Original demo"));
    }
    await writeFile(join(root, "design.html"), "<main>Changed</main>");
    const saved = rows.find((row) => JSON.parse(row.source).path);
    assert((await previews.document(saved.id)).includes("Original demo"));
    assert.equal(
      previews.observe(thread, "turn", {
        type: "fileChange",
        id: "change",
        changes: [{ path: "design.html", kind: { type: "update" } }],
      }).length,
      1,
    );
    assert.equal(
      previews.observe(thread, "turn", {
        type: "fileChange",
        id: "bad",
        changes: [{ path: "../outside.html", kind: { type: "update" } }],
      }).length,
      0,
    );
    assert.match(previewCsp, /sandbox allow-scripts/);
    assert(!previewCsp.includes("allow-same-origin"));
    assert.match(previewCsp, /connect-src 'none'/);
    assert.match(previewCsp, /form-action 'none'/);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
