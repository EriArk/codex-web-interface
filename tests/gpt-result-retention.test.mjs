import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GptService } from "../apps/hub/dist/gpt.js";
import { Store } from "../apps/hub/dist/store.js";
import { configSchema } from "../packages/shared/dist/index.js";

const root = mkdtempSync(join(tmpdir(), "gpt-audit-")),
  store = new Store(":memory:");
process.env.GPT_AUDIT_TOKEN = "isolated-test-value";
const config = configSchema.parse({
  hub: { publicBaseUrl: "https://audit.test", databasePath: ":memory:", resultsPath: root },
  auth: {},
  machines: [],
  projects: [],
  gpt: { endpoint: "http://127.0.0.1:1", tokenSecret: "GPT_AUDIT_TOKEN" },
});
const service = new GptService(config, store);
await service.close(); // Disable all background work; exercise persistence and authorization only.
try {
  const body = {
      nativeId: null,
      text: "Same draft after lost acknowledgement",
      files: [],
      model: "Latest",
      effort: "2",
    },
    key = randomUUID();
  service.enqueue(key, body);
  service.libraryBusy = true;
  service.enqueue(key, body); // A receipt lookup must survive transient connector/library state.
  service.libraryBusy = false;
  assert.equal(service.jobs().length, 1);
  service.enqueue(randomUUID(), body);
  assert.equal(service.jobs().length, 2);
  console.log(
    "CONFIRMED: actual Hub service deduplicates same key but accepts both copies after client key reset",
  );
  store.db.exec("DELETE FROM gpt_jobs");
  const old = randomUUID(),
    asset = {
      id: "audit-old-asset",
      name: "test.png",
      url: "/api/gpt/results/audit-old-asset",
      mime: "image/png",
      bytes: 1,
      image: true,
    };
  const insert = store.db.prepare(
    "INSERT INTO gpt_jobs VALUES(?,?,?,?,?,?,?,'completed','',?,?,?,'',NULL,1)",
  );
  insert.run(old, "hash", "native-chat", "old", "[]", "Latest", "2", JSON.stringify([asset]), 1, 1);
  service.response = async () => new Response("test");
  assert.equal((await service.result(asset.id)).status, 200);
  for (let i = 0; i < 100; i++)
    insert.run(
      randomUUID(),
      "hash",
      "another-chat",
      "new",
      "[]",
      "Latest",
      "2",
      "[]",
      i + 2,
      i + 2,
    );
  assert.equal(
    JSON.parse(store.db.prepare("SELECT assets FROM gpt_jobs WHERE id=?").get(old).assets)[0].id,
    asset.id,
  );
  assert.equal((await service.result(asset.id)).status, 200);
  service.library.save("thread", "native-chat", { deleted: true, name: "" });
  await assert.rejects(
    () => service.result(asset.id),
    (e) => e.code === "GPT_RESULT_NOT_FOUND",
  );
  service.library.save("thread", "native-chat", { deleted: false, name: "" });
  assert.equal((await service.result(asset.id)).status, 200);
  await assert.rejects(
    () => service.result("missing-artifact"),
    (e) => e.code === "GPT_RESULT_NOT_FOUND",
  );
  service.library.save("thread", "outbox:" + old, { deleted: true, name: "" });
  await assert.rejects(
    () => service.result(asset.id),
    (e) => e.code === "GPT_RESULT_NOT_FOUND",
  );
  console.log(
    "Old GPT artifacts remain available beyond 100 jobs; deleted and unknown results stay inaccessible",
  );
} finally {
  await service.close();
  store.close();
  rmSync(root, { recursive: true, force: true });
  delete process.env.GPT_AUDIT_TOKEN;
}
