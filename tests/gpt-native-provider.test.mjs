import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GptService } from "../apps/hub/dist/gpt.js";
import { Store } from "../apps/hub/dist/store.js";
import { configSchema } from "../packages/shared/dist/index.js";
import { nativeWorkspaceFixture } from "./fixtures/native-workspace.mjs";
import { handoffFixture } from "./handoff-fixture.mjs";

const until = async (fn) => {
  for (let i = 0; i < 200; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error("Timed out");
};
function setup(t) {
  const f = nativeWorkspaceFixture(),
    root = mkdtempSync(join(tmpdir(), "native-provider-")),
    store = new Store(":memory:");
  const config = configSchema.parse({
    hub: { publicBaseUrl: "https://native.test", databasePath: ":memory:", resultsPath: root },
    auth: {},
    machines: [],
    projects: [],
  });
  const services = [],
    open = () => {
      const s = new GptService(config, store, () => {}, f.workspace);
      services.push(s);
      return s;
    };
  t.after(async () => {
    for (const s of services) await s.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { ...f, store, config, open };
}
test("shared authenticated GPT routes use native catalog, pins, history and per-model presets", async (t) => {
  const native = nativeWorkspaceFixture(),
    f = await handoffFixture(undefined, undefined, { nativeGpt: native.workspace });
  t.after(() => f.close());
  const get = async (path) => {
    const r = await f.app.inject({ url: "/api/gpt/" + path, headers: f.headers });
    assert.equal(r.statusCode, 200, r.body);
    return r.json();
  };
  assert.equal((await get("models")).effortsByModel.fast[0].id, "0");
  assert.equal((await get("conversations")).items[0].pinned, true);
  assert.equal((await get("projects")).items[0].name, "Native project");
  const unauthenticated = await f.app.inject({ url: "/api/gpt/models" });
  assert.equal(unauthenticated.statusCode, 401);
  assert.equal(native.state.sends, 0);
});
test("native queue retains public progress across lost ack and restart without replay", async (t) => {
  const f = setup(t),
    first = f.open(),
    key = randomUUID();
  f.state.loseAck = true;
  first.enqueue(key, f.input);
  await until(() => first.job(key).status === "running" && first.job(key).progress?.length);
  assert.equal(first.job(key).answer, "Проверяю вложение");
  assert.equal(first.enqueue(key, f.input).id, key);
  assert.equal(f.state.sends, 1);
  await first.close();
  const second = f.open();
  assert.equal(second.job(key).status, "unknown");
  f.state.finished = true;
  await second.pump();
  assert.equal(second.job(key).status, "completed");
  assert.match(second.job(key).answer, /nativeworkspaceok/);
  assert.equal(f.state.sends, 1);
  assert.equal(
    f.store.db.prepare("SELECT provider FROM gpt_job_providers WHERE jobId=?").get(key).provider,
    "native",
  );
});
test("switching providers never dispatches a queued browser message through native", async (t) => {
  const f = setup(t),
    key = randomUUID();
  f.store.db
    .prepare(
      "INSERT INTO gpt_jobs VALUES(?,'old',?,'saved','[]','latest','1','queued','','[]',1,1,'',NULL,0)",
    )
    .run(key, f.conversationId);
  const service = f.open();
  await service.pump();
  assert.equal(service.job(key).status, "queued");
  assert.equal(f.state.sends, 0);
  assert.equal(
    f.store.db.prepare("SELECT provider FROM gpt_job_providers WHERE jobId=?").get(key).provider,
    "browser",
  );
  assert.throws(
    () => service.enqueue(randomUUID(), { ...f.input, nativeId: randomUUID() }),
    /ещё не подключено/,
  );
});
test("cancelling native preparation prevents dispatch after its delayed completion", async (t) => {
  const f = setup(t),
    service = f.open(),
    key = randomUUID();
  let release;
  f.state.preparing = new Promise((resolve) => {
    release = resolve;
  });
  service.enqueue(key, f.input);
  await until(() => service.job(key).status === "preparing");
  await service.cancel(key);
  release();
  await service.close();
  assert.equal(service.job(key).status, "cancelled");
  assert.equal(f.state.sends, 0);
});
test("native stop is bound to the job and only becomes cancelled after confirmation", async (t) => {
  const f = setup(t),
    service = f.open(),
    key = randomUUID();
  service.enqueue(key, f.input);
  await until(() => service.job(key).status === "running" && service.job(key).answer);
  await service.cancel(key);
  await service.pump();
  assert.equal(service.job(key).status, "cancelled");
  assert.equal(f.state.sends, 1);
});
test("attachment-only native send preserves an empty prompt without inventing user text", async (t) => {
  const f = setup(t),
    service = f.open(),
    key = randomUUID();
  const file = await service.put("note.txt", Buffer.from("Attachment only"));
  service.enqueue(key, { ...f.input, text: "", files: [file.id] });
  await until(() => service.job(key).status === "running");
  assert.equal(f.state.input.text, "");
  assert.equal(f.state.input.attachments.length, 1);
  assert.equal(f.state.uploads, 1);
});
