import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { releaseVersion } from "../apps/web/releaseVersion.ts";
import { readRelease, updateUrl } from "../apps/web/src/updateVersion.ts";

const bundle = {
  entry: { type: "chunk", isEntry: true, fileName: "assets/index-a.js" },
  main: { type: "asset", fileName: "assets/index-a.css" },
  gpt: { type: "asset", fileName: "assets/GptWorkspace-a.css" },
};
test("one boot release covers lazy route assets and detects CSS-only changes", () => {
  const version = releaseVersion(bundle);
  assert.equal(readRelease(version), version.id);
  assert.equal(version.styles.length, 2);
  assert.equal(releaseVersion(Object.fromEntries(Object.entries(bundle).reverse())).id, version.id);
  assert.notEqual(
    releaseVersion({ ...bundle, gpt: { ...bundle.gpt, fileName: "assets/GptWorkspace-b.css" } }).id,
    version.id,
  );
  assert.notEqual(
    releaseVersion({ ...bundle, main: { ...bundle.main, fileName: "assets/index-b.css" } }).id,
    version.id,
  );
  assert.equal(readRelease({ id: "invalid" }), null);
});
test("compiled HTML and version manifest identify exactly the same release", () => {
  const html = readFileSync(new URL("../apps/web/dist/index.html", import.meta.url), "utf8");
  const version = JSON.parse(
    readFileSync(new URL("../apps/web/dist/version.json", import.meta.url), "utf8"),
  );
  assert.match(html, new RegExp('name="codex-release" content="' + version.id + '"'));
  assert.equal(readRelease(version), version.id);
  // The original bug: a normal Codex boot does not load the lazy GPT stylesheet.
  assert(version.styles.some((style) => !html.includes(style)));
});
test("explicit update navigation preserves existing URL state and replaces the previous marker", () => {
  const next = new URL(
    updateUrl("https://codex.example.test/?mode=compact&_codex_update=old#chat", "a".repeat(64)),
  );
  assert.equal(next.origin, "https://codex.example.test");
  assert.equal(next.searchParams.get("mode"), "compact");
  assert.equal(next.searchParams.getAll("_codex_update").length, 1);
  assert.equal(next.searchParams.get("_codex_update"), "a".repeat(64));
  assert.equal(next.hash, "#chat");
});
