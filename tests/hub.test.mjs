import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApp } from "../apps/hub/dist/app.js";
import { Sessions } from "../apps/hub/dist/sessions.js";
import { Store } from "../apps/hub/dist/store.js";
import { configSchema } from "../packages/shared/dist/index.js";
import { capabilityReply } from "../tests/fixtures.mjs";

const require = createRequire(new URL("../apps/hub/package.json", import.meta.url));
const { WebSocket } = require("ws");
const origin = "https://codex.example.test";
const config = configSchema.parse({
  hub: {
    publicBaseUrl: origin,
    databasePath: ":memory:",
    resultsPath: join(tmpdir(), "codex-web-test-results"),
  },
  auth: { username: "owner" },
  machines: [{ id: "pc", name: "PC", type: "local-linux", codex: { command: "codex" } }],
  projects: [{ id: "project", name: "Project", machineId: "pc", workingDirectory: "/tmp" }],
});
class FakeRpc extends EventEmitter {
  closed = false;
  calls = [];
  responses = [];
  async initialize() {
    return {};
  }
  async request(method, params) {
    this.calls.push({ method, params });
    const capabilities = capabilityReply(method);
    if (capabilities) return capabilities;
    if (method === "account/read") return { account: { type: "chatgpt" } };
    if (method === "thread/start") return { thread: { id: randomUUID() } };
    if (method === "thread/resume") return { thread: { turns: [] } };
    if (method === "turn/start") {
      const turn = { id: randomUUID(), status: "inProgress" };
      this.emit("notification", "turn/started", { threadId: params.threadId, turn });
      return { turn };
    }
    return {};
  }
  respond(id, result) {
    this.responses.push({ id, result });
  }
  rejectRequest(id) {
    this.responses.push({ id, rejected: true });
  }
  close() {
    this.closed = true;
  }
}
test("chat history is bounded and older pages do not overlap; deltas are aggregated", () => {
  const s = new Store(":memory:");
  try {
    const t = s.createThread("p", "c", "Chat");
    for (let i = 0; i < 85; i++)
      s.append(t.id, "user.message", { id: `u${i}`, text: `Message ${i}` });
    s.append(t.id, "assistant.delta", { id: "a", text: "При" });
    s.append(t.id, "assistant.delta", { id: "a", text: "вет" });
    s.append(t.id, "assistant.completed", { id: "a", text: "Привет!", phase: "final_answer" });
    let page = s.history(t.id);
    assert.equal(page.messages.length, 20);
    assert.equal(page.messages.at(-1).text, "Привет!");
    assert.equal(page.messages.at(-1).role, "assistant");
    assert.equal(page.hasMore, true);
    const ids = new Set(page.messages.map((m) => m.id));
    while (page.hasMore) {
      page = s.history(t.id, page.nextBefore);
      assert.ok(page.messages.length <= 20);
      for (const m of page.messages) {
        assert.equal(ids.has(m.id), false);
        ids.add(m.id);
      }
    }
    assert.equal(ids.size, 86);
    assert.equal(s.history(t.id, undefined, 100000).messages.length, 30);
  } finally {
    s.close();
  }
});
test("idempotency never repeats an unacknowledged operation", async () => {
  const s = new Store(":memory:");
  let calls = 0;
  try {
    const id = randomUUID();
    const action = async () => {
      calls++;
      return { ok: true };
    };
    await s.once("scope", id, { text: "hello" }, action);
    await s.once("scope", id, { text: "hello" }, action);
    assert.equal(calls, 1);
    await assert.rejects(s.once("scope", id, { text: "different" }, action), {
      code: "IDEMPOTENCY_CONFLICT",
    });
    const failed = randomUUID();
    await assert.rejects(
      s.once("scope", failed, {}, async () => {
        throw new Error("lost connection");
      }),
    );
    await assert.rejects(s.once("scope", failed, {}, action), { code: "COMMAND_OUTCOME_UNKNOWN" });
    assert.equal(calls, 1);
  } finally {
    s.close();
  }
});
test("database restart preserves history and marks active work unknown", () => {
  const path = mkdtempSync(join(tmpdir(), "codex-store-"));
  try {
    let s = new Store(join(path, "db.sqlite"));
    const t = s.createThread("p", "c", "Chat");
    s.append(t.id, "user.message", { id: "u", text: "persist" });
    s.setStatus(t.id, "running", "turn");
    s.close();
    s = new Store(join(path, "db.sqlite"));
    assert.equal(s.thread(t.id).status, "unknown");
    assert.equal(s.history(t.id).messages[0].text, "persist");
    s.close();
  } finally {
    rmSync(path, { recursive: true });
  }
});
test("approvals and questions are single-use and scoped to the server request", async () => {
  const store = new Store(":memory:"),
    rpc = new FakeRpc(),
    sessions = new Sessions(config, store, () => rpc);
  try {
    const t = await sessions.create("project", "Test");
    await sessions.startTurn(t.id, "hello");
    rpc.emit("request", {
      id: 42,
      method: "item/commandExecution/requestApproval",
      params: { threadId: t.codexThreadId, command: "npm test" },
    });
    const approval = sessions.pending(t.id)[0];
    assert.equal(store.thread(t.id).status, "waiting_approval");
    await sessions.approve(approval.id, "decline");
    assert.deepEqual(rpc.responses.at(-1), { id: 42, result: { decision: "decline" } });
    await assert.rejects(sessions.approve(approval.id, "accept"), { code: "APPROVAL_EXPIRED" });
    rpc.emit("request", {
      id: 43,
      method: "item/tool/requestUserInput",
      params: {
        threadId: t.codexThreadId,
        questions: [{ id: "q", question: "Choose", options: [{ label: "A" }] }],
      },
    });
    const question = sessions.pending(t.id)[0];
    await sessions.answer(question.id, { q: ["A"] });
    assert.deepEqual(rpc.responses.at(-1), {
      id: 43,
      result: { answers: { q: { answers: ["A"] } } },
    });
    rpc.emit("notification", "turn/completed", {
      threadId: t.codexThreadId,
      turn: { id: store.thread(t.id).activeTurnId, status: "completed" },
    });
    assert.equal(store.thread(t.id).status, "completed");
  } finally {
    await sessions.close();
    store.close();
  }
});
test("the primary web writer retains a native conversation between completed turns", async () => {
  const store = new Store(":memory:"),
    rpc = new FakeRpc(),
    sessions = new Sessions(config, store, () => rpc);
  try {
    const t = store.createThread("project", "native-existing-id", "Imported");
    store.db
      .prepare("UPDATE threads SET origin='desktop',historyMode='paginated' WHERE id=?")
      .run(t.id);
    await sessions.resume(t.id);
    for (const prompt of ["first", "second"]) {
      await sessions.startTurn(t.id, prompt);
      rpc.emit("notification", "turn/completed", {
        threadId: t.codexThreadId,
        turn: { id: store.thread(t.id).activeTurnId, status: "completed" },
      });
    }
    assert.equal(rpc.calls.filter((c) => c.method === "thread/resume").length, 1);
    assert.equal(rpc.calls.filter((c) => c.method === "thread/unsubscribe").length, 0);
    assert.equal(store.thread(t.id).codexThreadId, "native-existing-id");
    assert.equal(store.history(t.id).messages.filter((m) => m.role === "user").length, 2);
  } finally {
    await sessions.close();
    store.close();
  }
});

test("private password enrollment, cookies, CSRF, auth and websocket revocation", async () => {
  const setupToken = randomBytes(32).toString("base64url"),
    password = `Only used by this isolated test ${randomBytes(12).toString("hex")}`;
  const store = new Store(":memory:"),
    rpc = new FakeRpc(),
    sessions = new Sessions(config, store, () => rpc);
  const { app } = await createApp(config, { store, sessions, setupToken });
  await app.listen({ host: "127.0.0.1", port: 0 });
  try {
    assert.equal((await app.inject({ url: "/api/projects" })).statusCode, 401);
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/auth/setup",
          headers: { origin: "https://hostile.test" },
          payload: { token: setupToken, password },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/auth/setup",
          headers: { origin },
          payload: { token: "x".repeat(43), password },
        })
      ).statusCode,
      403,
    );
    const enrolled = await app.inject({
      method: "POST",
      url: "/api/auth/setup",
      headers: { origin },
      payload: { token: setupToken, password },
    });
    assert.equal(enrolled.statusCode, 200, enrolled.body);
    const setCookie = enrolled.headers["set-cookie"];
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /Secure/);
    assert.match(setCookie, /SameSite=Strict/);
    assert.match(setCookie, /Path=\//);
    const cookie = setCookie.split(";")[0],
      csrf = enrolled.json().csrf;
    const hash = store.db.prepare("SELECT passwordHash FROM users").get().passwordHash;
    assert.match(hash, /^\$argon2id\$/);
    assert.equal(hash.includes(password), false);
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/auth/setup",
          headers: { origin },
          payload: { token: setupToken, password },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/auth/login",
          headers: { origin },
          payload: { password: "wrong" },
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/auth/login",
          headers: { origin },
          payload: { password },
        })
      ).statusCode,
      200,
    );
    const body = { title: "Protected chat" },
      id = randomUUID(),
      headers = { cookie, origin, "x-csrf-token": csrf, "idempotency-key": id };
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/projects/project/threads",
          headers: { cookie, origin },
          payload: body,
        })
      ).statusCode,
      403,
    );
    const created = await app.inject({
      method: "POST",
      url: "/api/projects/project/threads",
      headers,
      payload: body,
    });
    assert.equal(created.statusCode, 200, created.body);
    const t = created.json();
    const repeated = await app.inject({
      method: "POST",
      url: "/api/projects/project/threads",
      headers,
      payload: body,
    });
    assert.equal(repeated.json().id, t.id);
    const address = app.server.address();
    const url = `ws://127.0.0.1:${address.port}/api/events?threadId=${t.id}&after=0`;
    const rejected = new WebSocket(url, { headers: { origin } });
    const rejection = await new Promise((resolve) => {
      rejected.on("unexpected-response", (_r, response) => {
        resolve(response.statusCode);
        rejected.terminate();
      });
      rejected.on("error", () => {});
    });
    assert.equal(rejection, 401);
    const socket = new WebSocket(url, { headers: { cookie, origin } });
    const frames = [];
    socket.on("message", (data) => frames.push(JSON.parse(data.toString())));
    await once(socket, "open");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(frames.some((f) => f.type === "connection.ready"));
    const closed = once(socket, "close");
    const logout = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie, origin, "x-csrf-token": csrf },
    });
    assert.equal(logout.statusCode, 200);
    assert.equal((await closed)[0], 1008);
    assert.equal((await app.inject({ url: "/api/projects", headers: { cookie } })).statusCode, 401);
  } finally {
    await app.close();
  }
});

test("model, effort and native planning mode are validated and persist across thread reloads", async () => {
  const store = new Store(":memory:"),
    rpc = new FakeRpc(),
    sessions = new Sessions(config, store, () => rpc);
  try {
    const t = await sessions.create("project", "Settings");
    const caps = await sessions.capabilities("project");
    assert.equal(caps.defaults.effort, "xhigh");
    assert.equal(caps.models[1].supportsImages, false);
    await assert.rejects(
      sessions.setSettings(t.id, { model: "qa-text", effort: "ultra", mode: "plan" }),
      { code: "EFFORT_UNAVAILABLE" },
    );
    const selected = { model: "qa-model", effort: "low", mode: "plan" };
    await sessions.setSettings(t.id, selected);
    assert.deepEqual(store.thread(t.id).settings, selected);
    await sessions.startTurn(t.id, "Plan this task");
    const params = rpc.calls.findLast((call) => call.method === "turn/start").params;
    assert.equal(params.model, "qa-model");
    assert.equal(params.effort, "low");
    assert.deepEqual(params.collaborationMode, {
      mode: "plan",
      settings: { model: "qa-model", reasoning_effort: "low", developer_instructions: null },
    });
    rpc.emit("notification", "item/plan/delta", {
      threadId: t.codexThreadId,
      turnId: store.thread(t.id).activeTurnId,
      itemId: "plan",
      delta: "Draft",
    });
    rpc.emit("notification", "item/completed", {
      threadId: t.codexThreadId,
      turnId: store.thread(t.id).activeTurnId,
      item: { type: "plan", id: "plan", text: "Authoritative plan" },
    });
    assert.equal(store.history(t.id).messages.at(-1).text, "Authoritative plan");
    assert.equal(store.results(t.id).items[0].type, "plan");
  } finally {
    await sessions.close();
    store.close();
  }
});

test("resume reconciles the last interrupted message without replaying a prompt", async () => {
  const store = new Store(":memory:"),
    rpc = new FakeRpc();
  const t = store.createThread("project", randomUUID(), "Recovery");
  store.append(t.id, "user.message", { id: "u", text: "original request" }, "turn-1");
  store.append(t.id, "assistant.delta", { id: "a", text: "Partial" }, "turn-1");
  store.setStatus(t.id, "unknown", "turn-1");
  const request = rpc.request.bind(rpc);
  rpc.request = async (method, params) =>
    method === "thread/resume"
      ? {
          thread: {
            turns: [
              {
                id: "turn-1",
                status: "completed",
                items: [
                  { type: "userMessage", content: [{ type: "text", text: "original request" }] },
                  {
                    type: "agentMessage",
                    id: "a",
                    text: "Completed answer",
                    phase: "final_answer",
                  },
                ],
              },
            ],
          },
        }
      : request(method, params);
  const sessions = new Sessions(config, store, () => rpc);
  try {
    await sessions.resume(t.id);
    const history = store.history(t.id);
    assert.equal(history.messages.length, 2);
    assert.equal(history.messages[1].text, "Completed answer");
    assert.equal(
      rpc.calls.some((call) => call.method === "turn/start"),
      false,
    );
  } finally {
    await sessions.close();
    store.close();
  }
});

test("progress and multi-question requests remain scoped, resolvable and reconnectable", async () => {
  const store = new Store(":memory:"),
    rpc = new FakeRpc(),
    sessions = new Sessions(config, store, () => rpc);
  try {
    const t = await sessions.create("project", "Question");
    await sessions.startTurn(t.id, "Choose");
    const turnId = store.thread(t.id).activeTurnId;
    rpc.emit("notification", "item/started", {
      threadId: t.codexThreadId,
      turnId,
      item: { type: "reasoning", id: "reason" },
    });
    assert(
      store
        .events(t.id, 0)
        .some((e) => e.type === "turn.progress" && e.payload.label === "Обдумывает задачу"),
    );
    rpc.emit("request", {
      id: 201,
      method: "item/tool/requestUserInput",
      params: {
        threadId: t.codexThreadId,
        turnId,
        questions: [
          { id: "choice", question: "Pick?", options: [{ label: "A" }, { label: "B" }] },
          { id: "free", question: "Details?", options: [] },
        ],
      },
    });
    const question = sessions.pending(t.id)[0];
    assert.equal(store.thread(t.id).status, "waiting_approval");
    assert.equal(sessions.pending(t.id)[0].id, question.id);
    await assert.rejects(sessions.answer(question.id, { choice: ["B"] }), {
      code: "ANSWER_REQUIRED",
    });
    await sessions.answer(question.id, { choice: ["B"], free: ["Custom reply"] });
    assert.deepEqual(rpc.responses.at(-1), {
      id: 201,
      result: { answers: { choice: { answers: ["B"] }, free: { answers: ["Custom reply"] } } },
    });
    assert.equal(store.thread(t.id).status, "running");
    await assert.rejects(sessions.answer(question.id, { choice: ["A"] }), {
      code: "APPROVAL_EXPIRED",
    });
  } finally {
    await sessions.close();
    store.close();
  }
});
