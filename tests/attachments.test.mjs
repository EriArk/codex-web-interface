import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApp } from "../apps/hub/dist/app.js";
import { Attachments } from "../apps/hub/dist/attachments.js";
import { Sessions } from "../apps/hub/dist/sessions.js";
import { Store } from "../apps/hub/dist/store.js";
import { configSchema } from "../packages/shared/dist/index.js";

const require = createRequire(new URL("../apps/hub/package.json", import.meta.url)),
  sharp = require("sharp");
test("private uploads: image normalization, file bytes, ownership, paging metadata and delete-before-send", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-attachments-")),
    store = new Store(":memory:");
  try {
    const a = new Attachments(root, store),
      one = store.createThread("p", "c1", "One"),
      two = store.createThread("p", "c2", "Two");
    const original = Buffer.from("Private document\nwith unicode: проверка\n"),
      doc = await a.put(one.id, "report.txt", original);
    assert.deepEqual(await readFile(join(root, `${doc.id}.bin`)), original);
    await assert.rejects(a.put(one.id, "../outside.txt", original), { code: "INVALID_FILENAME" });
    await assert.rejects(a.put(one.id, "fake.png", original), { code: "IMAGE_UNSUPPORTED" });
    const image = await sharp({
      create: { width: 64, height: 40, channels: 3, background: "#119944" },
    })
      .png()
      .toBuffer();
    const photo = await a.put(one.id, "photo.png", image);
    assert.equal(photo.image, true);
    const meta = await sharp(join(root, `${photo.id}.jpg`)).metadata();
    assert.equal(meta.format, "jpeg");
    assert.equal(meta.width, 64);
    const config = {
      projects: [{ id: "p", machineId: "m" }],
      machines: [{ id: "m", type: "local-linux" }],
    };
    await assert.rejects(a.prepare(config, two.id, [doc.id], true), {
      code: "INVALID_ATTACHMENTS",
    });
    await assert.rejects(a.prepare(config, one.id, [photo.id], false), { code: "MODEL_NO_IMAGES" });
    a.bind(one.id, "user-message", [doc]);
    store.append(one.id, "user.message", { id: "user-message", text: "Read this" });
    assert.equal(store.history(one.id).messages[0].attachments[0].name, "report.txt");
    await assert.rejects(a.remove(doc.id), { code: "ATTACHMENT_IN_USE" });
    await a.remove(photo.id);
    assert.throws(() => a.get(photo.id), { code: "ATTACHMENT_NOT_FOUND" });
  } finally {
    store.close();
    await rm(root, { recursive: true });
  }
});
test("uploads and downloads require login and uploads require CSRF before accepting bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-upload-auth-"));
  const config = configSchema.parse({
    hub: {
      publicBaseUrl: "https://codex.example.test",
      databasePath: ":memory:",
      resultsPath: root,
    },
    auth: {},
    machines: [{ id: "m", name: "Local", type: "local-linux" }],
    projects: [{ id: "p", name: "Project", machineId: "m", workingDirectory: "/tmp" }],
  });
  const store = new Store(":memory:"),
    sessions = new Sessions(config, store),
    token = randomBytes(32).toString("base64url"),
    password = randomBytes(24).toString("hex");
  const { app } = await createApp(config, { store, sessions, setupToken: token });
  try {
    const thread = store.createThread("p", "codex", "Upload");
    const url = `/api/threads/${thread.id}/attachments?name=test.txt`,
      payload = Buffer.from("hello");
    const binary = { "content-type": "application/octet-stream", origin: config.hub.publicBaseUrl };
    assert.equal(
      (await app.inject({ method: "POST", url, headers: binary, payload })).statusCode,
      401,
    );
    const auth = await app.inject({
      method: "POST",
      url: "/api/auth/setup",
      headers: { origin: config.hub.publicBaseUrl },
      payload: { token, password },
    });
    const cookie = auth.headers["set-cookie"].split(";")[0],
      csrf = auth.json().csrf;
    assert.equal(
      (await app.inject({ method: "POST", url, headers: { ...binary, cookie }, payload }))
        .statusCode,
      403,
    );
    const transfer = `/api/upload-transfers/${randomUUID()}`,
      spec = { kind: "codex", threadId: thread.id, name: "chunk.txt", bytes: 5 };
    assert.equal(
      (await app.inject({ method: "POST", url: transfer, payload: spec })).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: transfer,
          headers: { cookie, origin: config.hub.publicBaseUrl },
          payload: spec,
        })
      ).statusCode,
      403,
    );
    const headers = { cookie, origin: config.hub.publicBaseUrl, "x-csrf-token": csrf };
    assert.equal(
      (await app.inject({ method: "POST", url: transfer, headers, payload: spec })).statusCode,
      200,
    );
    assert.equal(
      (
        await app.inject({
          method: "PUT",
          url: transfer + "?offset=0",
          headers: { ...headers, "content-type": "application/octet-stream" },
          payload,
        })
      ).statusCode,
      200,
    );
    const complete = await app.inject({
      method: "POST",
      url: transfer + "/complete",
      headers,
      payload: {},
    });
    assert.equal(complete.statusCode, 200, complete.body);
    assert.equal(
      (await app.inject({ url: complete.json().file.url, headers: { cookie } })).body,
      "hello",
    );
    assert.equal((await app.inject({ url: transfer })).statusCode, 401);
    const upload = await app.inject({
      method: "POST",
      url,
      headers: { ...binary, cookie, "x-csrf-token": csrf },
      payload,
    });
    assert.equal(upload.statusCode, 200, upload.body);
    const file = upload.json();
    assert.equal((await app.inject({ url: file.url })).statusCode, 401);
    const download = await app.inject({ url: file.url, headers: { cookie } });
    assert.equal(download.body, "hello");
    assert.match(download.headers["content-disposition"], /^attachment;/);
    assert.equal(download.headers["cache-control"], "no-store");
  } finally {
    await app.close();
    await rm(root, { recursive: true });
  }
});
