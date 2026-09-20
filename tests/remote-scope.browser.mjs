import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium, webkit } from "@playwright/test";

const source = await readFile("apps/web/src/Remote.tsx", "utf8");
const setup = source.match(
  /const scopedUrl = new URL\(workspaceUrl\(url\)\);[\s\S]*?const tunnel = .*?;/,
)?.[0];
const connect = source.match(
  /scopedUrl.searchParams.set\("width"[\s\S]*?client.connect\(scopedUrl.searchParams.toString\(\)\);/,
)?.[0];
assert.ok(setup && connect, "Use the actual Remote connection construction");
for (const type of [chromium, webkit]) {
  const browser = await type.launch();
  try {
    const page = await browser.newPage();
    await page.addScriptTag({
      content: await readFile("apps/web/public/vendor/guacamole-1.6.0.min.js", "utf8"),
    });
    const result = await page.evaluate(
      ({ setup, connect }) => {
        window.WebSocket = class {
          constructor(url, protocol) {
            window.opened = { url, protocol };
          }
          close() {}
        };
        const run = new Function(
          "G",
          "workspaceUrl",
          "url",
          "surface",
          `${setup}\nconst client = new G.Client(tunnel);\n${connect}\nconst opened = window.opened; client.disconnect(); return opened;`,
        );
        return run(
          Guacamole,
          (url) => url + "?workspace=member-123",
          "wss://example.test/api/projects/demo/remote",
          { clientWidth: 390, clientHeight: 720 },
        );
      },
      { setup, connect },
    );
    const url = new URL(result.url);
    assert.equal(url.searchParams.get("workspace"), "member-123");
    assert.equal(url.searchParams.get("width"), "390");
    assert.equal(url.searchParams.get("height"), "720");
    assert.equal(result.protocol, "guacamole");
    console.log(type.name() + ": native Guacamole URL preserves account scope and dimensions");
  } finally {
    await browser.close();
  }
}
