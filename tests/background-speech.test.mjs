import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApp } from "../apps/hub/dist/app.js";
import { SpeechClips, speechWorker } from "../apps/hub/dist/speech.js";
import { AudioMessageSpeech } from "../apps/web/src/audioSpeech.ts";
import { configSchema } from "../packages/shared/dist/index.js";

const wave = Buffer.alloc(100);
wave.write("RIFF");
wave.write("WAVE", 8);
const tick = () => new Promise((resolve) => setImmediate(resolve));
test("private speech media requires a session, CSRF, same-owner access and supports Safari range reads", {
  skip: process.platform === "win32",
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-speech-")),
    socket = join(root, "voice.sock");
  let calls = 0;
  let workerCapabilities;
  const requestedVoices = [];
  const worker = createServer((req, res) => {
    if (req.url === "/health")
      return res.end(workerCapabilities ? JSON.stringify(workerCapabilities) : "ok");
    calls++;
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      assert.equal(JSON.parse(body).text, "Привет");
      requestedVoices.push(JSON.parse(body).voice);
      res.end(wave);
    });
  });
  worker.listen(socket);
  await once(worker, "listening");
  const config = configSchema.parse({
    hub: {
      publicBaseUrl: "https://example.test",
      databasePath: join(root, "app.db"),
      resultsPath: join(root, "results"),
      speechSocket: socket,
    },
    auth: {},
    machines: [{ id: "local", name: "Local", type: "local-linux" }],
    projects: [],
  });
  const setupToken = randomBytes(32).toString("base64url"),
    password = randomBytes(24).toString("base64url");
  const { app } = await createApp(config, { setupToken });
  t.after(async () => {
    await app.close();
    worker.closeAllConnections();
    await new Promise((r) => worker.close(r));
    await rm(root, { recursive: true, force: true });
  });
  const origin = config.hub.publicBaseUrl;
  const enroll = await app.inject({
    method: "POST",
    url: "/api/auth/setup",
    headers: { origin },
    payload: { token: setupToken, password },
  });
  assert.equal(enroll.statusCode, 200);
  const headers = {
    origin,
    cookie: enroll.headers["set-cookie"].split(";")[0],
    "x-csrf-token": enroll.json().csrf,
  };
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { origin },
    payload: { password },
  });
  const other = {
    origin,
    cookie: login.headers["set-cookie"].split(";")[0],
    "x-csrf-token": login.json().csrf,
  };
  const id = randomUUID(),
    url = "/api/speech/" + id,
    payload = { text: "Привет", language: "ru" };
  assert.equal((await app.inject({ url: url + "/audio" })).statusCode, 401);
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url,
        headers: { cookie: headers.cookie, origin },
        payload,
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url,
        headers,
        payload: { ...payload, text: "x".repeat(30001) },
      })
    ).statusCode,
    400,
  );
  assert.deepEqual((await app.inject({ url: "/api/speech/status", headers })).json(), {
    available: true,
  });
  const early = app.inject({ url: url + "/audio", headers });
  await tick();
  assert.equal((await app.inject({ method: "POST", url, headers, payload })).statusCode, 202);
  const audio = await early;
  assert.equal(audio.statusCode, 200);
  assert.deepEqual(audio.rawPayload, wave);
  assert.match(audio.headers["cache-control"], /no-store/);
  assert.equal((await app.inject({ method: "POST", url, headers, payload })).statusCode, 202);
  assert.equal(calls, 1);
  assert.equal(
    (await app.inject({ method: "POST", url, headers, payload: { ...payload, text: "Other" } }))
      .statusCode,
    409,
  );
  assert.equal((await app.inject({ url: url + "/audio", headers: other })).statusCode, 404);
  const range = await app.inject({
    url: url + "/audio",
    headers: { ...headers, range: "bytes=0-1" },
  });
  assert.equal(range.statusCode, 206);
  assert.equal(range.headers["content-range"], "bytes 0-1/100");
  assert.deepEqual(range.rawPayload, wave.subarray(0, 2));
  const suffix = await app.inject({
    url: url + "/audio",
    headers: { ...headers, range: "bytes=-10" },
  });
  assert.equal(suffix.statusCode, 206);
  assert.equal(suffix.rawPayload.length, 10);
  for (const range of ["bytes=100-", "bytes=20-10", "bytes=-0", "bytes=0-1,3-4", "bytes=-"]) {
    assert.equal(
      (await app.inject({ url: url + "/audio", headers: { ...headers, range } })).statusCode,
      416,
    );
  }
  await app.inject({ method: "DELETE", url, headers: other });
  assert.equal((await app.inject({ url: url + "/audio", headers })).statusCode, 200);
  const unsupported = "/api/speech/" + randomUUID();
  await app.inject({
    method: "POST",
    url: unsupported,
    headers,
    payload: { ...payload, voice: "kseniya" },
  });
  assert.equal((await app.inject({ url: unsupported + "/audio", headers })).statusCode, 503);
  assert.equal(calls, 1, "old worker cannot silently substitute a requested voice");
  workerCapabilities = {
    voices: ["eugene", "kseniya", "ruslan", "untrusted"],
    defaultVoice: "eugene",
    mixedLanguage: true,
  };
  assert.deepEqual((await app.inject({ url: "/api/speech/status", headers })).json(), {
    available: true,
    voices: ["eugene", "kseniya", "ruslan"],
    defaultVoice: "eugene",
    mixedLanguage: true,
  });
  for (const voice of ["eugene", "kseniya", "ruslan"]) {
    const voiceUrl = "/api/speech/" + randomUUID();
    const voicePayload = { ...payload, voice };
    assert.equal(
      (await app.inject({ method: "POST", url: voiceUrl, headers, payload: voicePayload }))
        .statusCode,
      202,
    );
    assert.equal((await app.inject({ url: voiceUrl + "/audio", headers })).statusCode, 200);
    assert.equal(requestedVoices.at(-1), voice);
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: voiceUrl,
          headers,
          payload: { ...payload, voice: voice === "eugene" ? "ruslan" : "eugene" },
        })
      ).statusCode,
      409,
    );
  }
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/speech/" + randomUUID(),
        headers,
        payload: { ...payload, voice: "../../x" },
      })
    ).statusCode,
    400,
  );
  await app.inject({ method: "POST", url: "/api/auth/logout", headers });
  assert.equal((await app.inject({ url: url + "/audio", headers })).statusCode, 401);
});
test("speech preparation is bounded, cancelable, idempotent and does not resurrect a deleted clip", async () => {
  let finish,
    signal,
    calls = 0;
  const clips = new SpeechClips((_text, _lang, s) => {
    signal = s;
    calls++;
    return new Promise((r) => {
      finish = r;
    });
  });
  try {
    clips.create("one", "owner", "Text", "en");
    clips.create("one", "owner", "Text", "en");
    assert.equal(calls, 1);
    assert.throws(
      () => clips.create("two", "owner", "Text", "en"),
      (error) => error.code === "SPEECH_BUSY",
    );
    const reading = clips.read("one", "owner");
    clips.remove("one", "other");
    assert.equal(signal.aborted, false);
    clips.remove("one", "owner");
    assert.equal(signal.aborted, true);
    finish(wave);
    await assert.rejects(reading);
    clips.create("two", "owner", "Text", "en");
    finish(wave);
    assert.deepEqual(await clips.read("two", "owner"), wave);
  } finally {
    clips.close();
  }
});
test("speech worker rejects malformed media and never accepts a truncated stream", {
  skip: process.platform === "win32",
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "speech-bad-")),
    socket = join(root, "voice.sock");
  let mode = "bad";
  const server = createServer((_req, res) => {
    if (mode === "bad") res.end("not audio");
    else {
      res.writeHead(200, { "Content-Length": 1000 });
      res.write(wave);
      setImmediate(() => res.destroy());
    }
  });
  server.listen(socket);
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await rm(root, { recursive: true, force: true });
  });
  await assert.rejects(speechWorker(socket, "Text", "en", AbortSignal.timeout(2000)));
  mode = "short";
  await assert.rejects(speechWorker(socket, "Text", "en", AbortSignal.timeout(2000)));
});
function playerFixture() {
  const tracks = [],
    created = [],
    removed = [],
    actions = new Map(),
    playback = [];
  let finish;
  const media = { setActionHandler: (key, fn) => actions.set(key, fn), setPositionState: () => {} };
  const player = new AudioMessageSpeech({
    audio: () => {
      const a = {
        currentTime: 0,
        duration: 120,
        playbackRate: 1,
        plays: 0,
        play() {
          this.plays++;
          return Promise.resolve();
        },
        pause() {
          this.onpause?.();
        },
        removeAttribute() {},
        load() {},
      };
      tracks.push(a);
      return a;
    },
    create: (id, text, language) => {
      created.push({ id, text, language });
      return new Promise((r) => {
        finish = r;
      });
    },
    remove: async (id) => {
      removed.push(id);
    },
    media: () => media,
    playback: (active) => playback.push(active),
  });
  return { player, tracks, created, removed, actions, playback, complete: () => finish() };
}
test("audio starts in the tap, remains one track and supports lock-screen pause/resume/seek", async () => {
  const f = playerFixture();
  f.player.start("gpt:one", "Привет", "ru");
  assert.equal(f.tracks.length, 1);
  assert.equal(f.tracks[0].plays, 1);
  assert.equal(f.player.snapshot().phase, "loading");
  f.complete();
  await tick();
  const a = f.tracks[0];
  a.onplaying();
  assert.equal(f.player.snapshot().phase, "speaking");
  f.actions.get("pause")({});
  assert.equal(f.player.snapshot().phase, "paused");
  f.actions.get("play")({});
  a.onplaying();
  assert.equal(a.plays, 2);
  assert.equal(f.created.length, 1);
  f.actions.get("seekto")({ seekTime: 40 });
  f.actions.get("seekbackward")({ seekOffset: 10 });
  assert.equal(a.currentTime, 30);
  f.actions.get("seekforward")({ seekOffset: 15 });
  assert.equal(a.currentTime, 45);
  a.onended();
  assert.equal(f.player.snapshot().phase, "idle");
  assert(f.removed.includes(f.created[0].id));
  assert.equal(f.actions.get("play"), null);
});
test("stopped audio cannot return through late creation, playback or error callbacks", async () => {
  const f = playerFixture();
  f.player.start("codex:one", "One", "en");
  const old = f.tracks[0],
    latePlaying = old.onplaying,
    lateError = old.onerror;
  f.player.stopScope("codex");
  f.complete();
  await tick();
  assert(f.removed.filter((id) => id === f.created[0].id).length >= 2);
  f.player.start("gpt:two", "Two", "en");
  latePlaying();
  lateError();
  assert.equal(f.player.snapshot().id, "gpt:two");
  f.player.stop();
});

test("PWA caches only the workspace shell, never the protected Remote page or private audio", async () => {
  const vm = await import("node:vm"),
    { readFile } = await import("node:fs/promises");
  const events = {},
    cached = [];
  let response;
  vm.runInNewContext(await readFile(new URL("../apps/web/public/sw.js", import.meta.url), "utf8"), {
    self: {
      location: { origin: "https://app.test" },
      addEventListener: (key, fn) => (events[key] = fn),
    },
    URL,
    location: { origin: "https://app.test" },
    console,
    fetch: async () => ({ ok: true, clone: () => ({ shell: true }) }),
    caches: { open: async () => ({ put: async (key, value) => cached.push({ key, value }) }) },
  });
  for (const path of [
    "/gpt-connect?immersive=1",
    "/gpt-connect/",
    "/api/speech/id/audio",
    "/api/results/file",
  ]) {
    events.fetch({
      request: { url: "https://app.test" + path, method: "GET", mode: "navigate" },
      respondWith: () => {
        throw Error("Private route intercepted");
      },
    });
  }
  events.fetch({
    request: { url: "https://app.test/", method: "GET", mode: "navigate" },
    respondWith: (p) => {
      response = p;
    },
  });
  await response;
  await tick();
  assert.equal(cached.length, 1);
  assert.equal(cached[0].key, "/");
});
