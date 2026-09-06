import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApp } from "../apps/hub/dist/app.js";
import { Store } from "../apps/hub/dist/store.js";
import {
  compareActivity,
  compareThreadActivity,
  configSchema,
} from "../packages/shared/dist/index.js";

const require = createRequire(new URL("../apps/hub/package.json", import.meta.url));
const { WebSocket } = require("ws");
const complete = (store, id, turnId = randomUUID(), status = "completed") => {
  store.setStatus(id, status);
  return store.append(id, "turn.completed", { status }, turnId).seq;
};

test("navigation has exact counts beyond the list bound, stable active order and no conversation contents", () => {
  const store = new Store(":memory:");
  try {
    const older = store.createThread("p", "older", "Active older");
    for (let i = 0; i < 220; i++) store.createThread("p", "idle-" + i, "Idle " + i);
    const newer = store.createThread("q", "newer", "Active newer");
    const unread = store.createThread("q", "done", "Finished");
    store.append(older.id, "user.message", {
      id: "private",
      text: "private-message-must-not-travel",
    });
    store.setStatus(older.id, "starting");
    store.db
      .prepare("UPDATE threads SET activityAt=? WHERE id=?")
      .run("2026-09-06T01:00:00.000Z", older.id);
    store.setStatus(newer.id, "running", "new-turn");
    store.db
      .prepare("UPDATE threads SET activityAt=? WHERE id=?")
      .run("2026-09-06T02:00:00.000Z", newer.id);
    complete(store, unread.id);
    store.setStatus(older.id, "waiting_approval", "old-turn");
    const state = store.navigation(["p", "q"]);
    assert.equal(state.projects.find((p) => p.id === "p").active, 1);
    assert.equal(state.projects.find((p) => p.id === "p").waiting, 1);
    assert.equal(state.projects.find((p) => p.id === "q").unread, 1);
    assert.equal(state.threads.filter((t) => t.projectId === "p").length, 200);
    assert.equal(store.threads("p")[0].id, older.id);
    assert.equal(state.threads.sort(compareThreadActivity)[0].id, newer.id);
    assert.equal(state.projects.sort(compareActivity)[0].id, "q");
    assert.equal(store.thread(older.id).activityAt, "2026-09-06T01:00:00.000Z");
    assert(!JSON.stringify(state).includes("private-message-must-not-travel"));
    store.db.prepare("UPDATE threads SET archived=1 WHERE id=?").run(older.id);
    assert.equal(store.navigation(["p"]).projects[0].active, 0);
    assert(!store.navigation(["p"]).threads.some((t) => t.id === newer.id));
  } finally {
    store.close();
  }
});

test("seen completion survives restart; stale acknowledgements and duplicate completion cannot lose new work", () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-seen-"));
  let store = new Store(join(directory, "app.db"));
  try {
    const t = store.createThread("p", "native", "Chat");
    assert.equal(store.navigation(["p"]).projects[0].unread, 0);
    const first = complete(store, t.id, "first");
    store.markSeen(t.id, first);
    const second = complete(store, t.id, "second", "failed");
    store.markSeen(t.id, first);
    assert.equal(store.navigation(["p"]).projects[0].unread, 1);
    assert.equal(store.thread(t.id).completedStatus, "failed");
    complete(store, t.id, "second", "failed");
    assert.equal(store.thread(t.id).completedSeq, second);
    store.close();
    store = new Store(join(directory, "app.db"));
    assert.equal(store.thread(t.id).seenSeq, first);
    assert.equal(store.navigation(["p"]).projects[0].unread, 1);
    store.markSeen(t.id, second);
    store.markSeen(t.id, first);
    assert.equal(store.navigation(["p"]).projects[0].unread, 0);
    assert.equal(store.thread(t.id).seenSeq, second);
    store.setStatus(t.id, "running", "third");
    store.close();
    store = new Store(join(directory, "app.db"));
    assert.equal(store.thread(t.id).status, "unknown");
    assert.equal(store.navigation(["p"]).projects[0].unread, 0, "A disconnect is not a completion");
  } finally {
    store.close();
    rmSync(directory, { recursive: true });
  }
});

test("global navigation stream updates unopened chats and read receipts across clients, then revokes on logout", async () => {
  const origin = "https://codex.example.test",
    setupToken = randomBytes(32).toString("base64url");
  const config = configSchema.parse({
    hub: {
      publicBaseUrl: origin,
      databasePath: ":memory:",
      resultsPath: join(tmpdir(), "codex-nav-test"),
    },
    auth: { username: "owner" },
    machines: [{ id: "local", name: "Local", type: "local-linux" }],
    projects: [{ id: "p", name: "Project", machineId: "local", workingDirectory: "/tmp" }],
  });
  const { app, store } = await createApp(config, { setupToken });
  const sockets = [];
  await app.listen({ host: "127.0.0.1", port: 0 });
  try {
    assert.equal((await app.inject({ url: "/api/navigation" })).statusCode, 401);
    const enrolled = await app.inject({
      method: "POST",
      url: "/api/auth/setup",
      headers: { origin },
      payload: { token: setupToken, password: randomBytes(24).toString("base64url") },
    });
    const cookie = enrolled.headers["set-cookie"].split(";")[0],
      csrf = enrolled.json().csrf;
    const headers = { origin, cookie, "x-csrf-token": csrf };
    const t = store.createThread("p", "native", "Unopened");
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: `/api/threads/${t.id}/seen`,
          headers: { origin, cookie },
          payload: { completedSeq: 1 },
        })
      ).statusCode,
      403,
    );
    const frames = [[], []];
    for (let i = 0; i < 2; i++) {
      const socket = new WebSocket(
        `ws://127.0.0.1:${app.server.address().port}/api/navigation/events`,
        { headers: { origin, cookie } },
      );
      sockets.push(socket);
      socket.on("message", (data) => frames[i].push(JSON.parse(data)));
      await once(socket, "open");
    }
    const waitFor = async (predicate) => {
      for (let i = 0; i < 100; i++) {
        if (predicate()) return;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw Error("No navigation frame");
    };
    await waitFor(() => frames.every((f) => f.at(-1)?.threads.some((item) => item.id === t.id)));
    store.setStatus(t.id, "running", "turn");
    await waitFor(() => frames.every((f) => f.at(-1)?.projects[0]?.active === 1));
    const seq = complete(store, t.id, "turn");
    await waitFor(() => frames.every((f) => f.at(-1)?.projects[0]?.unread === 1));
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: `/api/threads/${t.id}/seen`,
          headers,
          payload: { completedSeq: seq },
        })
      ).statusCode,
      200,
    );
    await waitFor(() => frames.every((f) => f.at(-1)?.projects[0]?.unread === 0));
    const closed = sockets.map((s) => once(s, "close"));
    await app.inject({ method: "POST", url: "/api/auth/logout", headers });
    await Promise.all(closed);
    await waitFor(() => store.changes.listenerCount("navigation") === 0);
  } finally {
    for (const socket of sockets) socket.terminate();
    await app.close();
  }
});
