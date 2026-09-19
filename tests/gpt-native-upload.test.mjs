import assert from "node:assert/strict";
import { createHash, randomUUID, webcrypto } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { NativeGptJobs } from "../apps/hub/dist/gpt-native-jobs.js";
import { NativeDispatchReceipts } from "../ops/gpt-native/dispatch-receipts.mjs";
import { nativeUpload } from "../ops/gpt-native/renderer-upload.mjs";

const principal = { accountId: "account", userId: "user", authenticatedUserId: "user" };
const hash = (x) => createHash("sha256").update(x).digest("hex");
const accountFingerprint = hash(JSON.stringify(Object.values(principal)));
function fixture() {
  const bytes = Buffer.from("native upload fixture");
  const input = {
    key: randomUUID(),
    conversationId: randomUUID(),
    accountFingerprint,
    file: {
      id: randomUUID(),
      name: "proof.txt",
      mime: "text/plain",
      bytes: bytes.length,
      sha256: hash(bytes),
      base64: bytes.toString("base64"),
    },
  };
  const state = {
    requests: [],
    changed: false,
    target: "https://chatgpt.com/backend-api/estuary/upload_content_bytes?upload_url=private",
    event: "file.processing.file_ready",
  };
  const send = async (url, o) => {
    assert.deepEqual(
      o.expectedIdentity,
      o.method === "PUT" ? undefined : { accountId: "account", userId: "user" },
    );
    assert.equal(o.retry, false);
    o.assertRequestCurrent();
    assert.throws(() => o.assertRequestCurrent(), /REPLAY/);
    state.requests.push(url);
    if (url === "/files") return Response.json({ file_id: "file-proof", upload_url: state.target });
    if (url === "/files/process_upload_stream")
      return new Response(`${JSON.stringify({ event: state.event })}\n`);
    assert.equal(o.headers["X-OpenAI-Attach-Auth"], o.method === "PUT" ? undefined : "1");
    assert.ok(o.body instanceof Uint8Array);
    if (state.changed) principal.accountId = "other";
    return new Response("");
  };
  const m = {
    M9: { accessInputs: { readAccountInfo: async () => ({ status: "ready", data: principal }) } },
    kWt: { postResponse: send },
    $rn: { getInstance: () => ({ fetch: send }) },
  };
  const run = () =>
    nativeUpload(
      input,
      async () => ({ accountFingerprint }),
      async () => m,
      {
        crypto: webcrypto,
        atob,
        createImageBitmap: async () => ({ width: 64, height: 32, close() {} }),
      },
    );
  return { input, state, run };
}
test("native upload uses three principal-bound non-retrying operations and returns no signed URL", async () => {
  const f = fixture(),
    result = await f.run();
  assert.equal(f.state.requests.length, 3);
  assert.deepEqual(result, {
    id: "file-proof",
    name: "proof.txt",
    mimeType: "text/plain",
    size: 21,
    source: "local",
  });
  assert.ok(!JSON.stringify(result).includes("private"));
});
test("changed bytes and unsupported signed destinations cannot transfer content", async () => {
  const f = fixture();
  f.input.file.sha256 = "0".repeat(64);
  await assert.rejects(f.run(), /UPLOAD_CHANGED/);
  assert.equal(f.state.requests.length, 0);
  const g = fixture();
  g.state.target = "https://evil.example/backend-api/estuary/upload_content_bytes?upload_url=x";
  await assert.rejects(g.run(), /UNSUPPORTED_UPLOAD_TARGET/);
  assert.equal(g.state.requests.length, 1);
});
test("native direct object storage uses PUT without an account auth marker", async () => {
  const f = fixture();
  f.state.target = "https://sdmntprdenmarkeast.oaiusercontent.com/private?sig=fixture";
  assert.equal((await f.run()).id, "file-proof");
  assert.equal(f.state.requests.length, 3);
});
test("Hub attachment queue binds snapshots, commits before send and resumes by reading without upload replay", async (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(
    "CREATE TABLE gpt_jobs(id TEXT PRIMARY KEY,fingerprint TEXT,nativeId TEXT,text TEXT,files TEXT,model TEXT,effort TEXT,status TEXT,answer TEXT,assets TEXT,createdAt INTEGER,updatedAt INTEGER,error TEXT,requestId TEXT,submitted INTEGER)",
  );
  const f = fixture(),
    id = f.input.key,
    conversationId = f.input.conversationId,
    parentId = randomUUID();
  const file = {
    id: f.input.file.id,
    name: "proof.txt",
    mime: "text/plain",
    bytes: f.input.file.bytes,
    url: "fixture:private",
    image: false,
  };
  db.prepare(
    "INSERT INTO gpt_jobs VALUES(?,'hash',?,'prompt',?,'latest','1','queued','','[]',1,1,'',NULL,0)",
  ).run(id, conversationId, JSON.stringify([file]));
  let sends = 0,
    uploads = 0,
    reads = 0,
    sent;
  const client = {
    prepareDispatch: async (r) => ({
      parentId,
      model: "model",
      effort: null,
      versionId: r.versionId,
      presetId: r.presetId,
    }),
    uploadFile: async (r) => {
      uploads++;
      assert.equal(r.file.sha256, f.input.file.sha256);
      assert.equal(db.prepare("SELECT count(*) n FROM gpt_native_files").get().n, 1);
      return {
        id: file.id,
        sha256: r.file.sha256,
        native: {
          id: "file-proof",
          name: file.name,
          mimeType: file.mime,
          size: file.bytes,
          source: "local",
        },
      };
    },
    dispatchText: async (r) => {
      sends++;
      sent = r;
      assert.equal(r.attachments.length, 1);
      assert.equal(db.prepare("SELECT count(*) n FROM gpt_native_receipts").get().n, 1);
      throw Error("lost");
    },
    reconcileDispatch: async () => ({
      state: "completed",
      userMessageId: sent.userMessageId,
      messages: [],
    }),
  };
  const open = () =>
    new NativeGptJobs(
      { db },
      client,
      () => {},
      new Set([conversationId]),
      new Set(),
      async () => {
        reads++;
        return Buffer.from(f.input.file.base64, "base64");
      },
    );
  assert.equal((await open().run(id)).status, "completed");
  assert.equal((await open().run(id)).status, "completed");
  assert.equal(sends, 1);
  assert.equal(uploads, 1);
  assert.equal(reads, 1);
  db.prepare("UPDATE gpt_jobs SET files='[]' WHERE id=?").run(id);
  await assert.rejects(open().reconcile(id), /SUBMISSION_MISMATCH/);
});
test("file processing must explicitly confirm readiness, including PNG dimensions", async () => {
  const f = fixture();
  f.state.event = "file.processing.started";
  await assert.rejects(f.run(), /UPLOAD_NOT_READY/);
  const g = fixture(),
    bytes = Buffer.alloc(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  bytes.writeUInt32BE(64, 16);
  bytes.writeUInt32BE(32, 20);
  Object.assign(g.input.file, {
    mime: "image/png",
    bytes: bytes.length,
    sha256: hash(bytes),
    base64: bytes.toString("base64"),
  });
  const value = await g.run();
  assert.equal(value.width, 64);
  assert.equal(value.height, 32);
});
test("account changes stop processing after byte upload", async () => {
  const f = fixture();
  f.state.changed = true;
  try {
    await assert.rejects(f.run(), /ACCOUNT_CHANGED/);
    assert.equal(f.state.requests.length, 2);
  } finally {
    principal.accountId = "account";
  }
});
test("upload receipt survives restart, rejects changed bytes and never retries unknown native upload", async (t) => {
  const f = fixture(),
    root = mkdtempSync(join(tmpdir(), "native-upload-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const options = {
    path: join(root, "receipts.sqlite"),
    userId: randomUUID(),
    accountFingerprint,
    conversationIds: [f.input.conversationId, randomUUID()],
  };
  let ledger = new NativeDispatchReceipts(options),
    calls = 0;
  const reader = {
    uploadFile: async () => {
      calls++;
      return {
        id: "file-proof",
        name: f.input.file.name,
        mimeType: f.input.file.mime,
        size: f.input.file.bytes,
        source: "local",
      };
    },
  };
  const first = await ledger.upload(f.input, reader);
  ledger.close();
  ledger = new NativeDispatchReceipts(options);
  try {
    assert.deepEqual(await ledger.upload(f.input, reader), first);
    assert.equal(calls, 1);
    await assert.rejects(
      ledger.dispatch(
        {
          key: f.input.key,
          conversationId: options.conversationIds[1],
          userMessageId: randomUUID(),
          text: "prompt",
          versionId: "latest",
          presetId: 1,
          parentId: randomUUID(),
          model: "model",
          effort: null,
          intentPersisted: true,
          attachments: [first],
        },
        {},
      ),
      /UPLOAD_MISMATCH/,
    );
    await assert.rejects(
      ledger.upload({ ...f.input, file: { ...f.input.file, name: "changed.txt" } }, reader),
      /UPLOAD_CHANGED/,
    );
    const unknown = { ...f.input, file: { ...f.input.file, id: randomUUID() } };
    await assert.rejects(
      ledger.upload(unknown, {
        uploadFile: async () => {
          calls++;
          throw Error("disconnected");
        },
      }),
      /disconnected/,
    );
    await assert.rejects(ledger.upload(unknown, reader), /UPLOAD_UNKNOWN/);
    assert.equal(calls, 2);
  } finally {
    ledger.close();
  }
});
