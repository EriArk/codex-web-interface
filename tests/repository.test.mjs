import assert from "node:assert/strict";
import test from "node:test";
import { forbiddenFile } from "../scripts/check-repository.mjs";

test("repository guard rejects private state and build artifacts without echoing secret content", () => {
  for (const path of [
    "data/app.db",
    "apps/web/dist/index.html",
    ".local/report.json",
    "config.local.yaml",
    "ssh/known_hosts",
    ".env",
    "remote.env",
  ])
    assert(forbiddenFile(path), path);
  for (const path of [
    "config.example.yaml",
    ".env.example",
    "docs/SECURITY.md",
    "apps/hub/src/auth.ts",
  ])
    assert.equal(forbiddenFile(path), undefined);
  const secret = "-----BEGIN " + "OPENSSH PRIVATE KEY-----";
  const result = forbiddenFile("innocent.txt", Buffer.from(secret));
  assert(result);
  assert(!result.includes(secret));
});
