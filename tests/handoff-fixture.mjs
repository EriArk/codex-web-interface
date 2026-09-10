import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApp } from "../apps/hub/dist/app.js";
import { Sessions } from "../apps/hub/dist/sessions.js";
import { Store } from "../apps/hub/dist/store.js";
import { configSchema } from "../packages/shared/dist/index.js";
import { capabilityReply } from "./fixtures.mjs";

export const origin = "https://handoff.test";
export const settings = { model: "qa-model", effort: "high", mode: "default", access: "workspace" };
export async function handoffFixture(
  publicOrigin = origin,
  webRoot = resolve("apps/web/dist"),
  appOptions = {},
) {
  const root = await mkdtemp(join(tmpdir(), "codex-handoff-"));
  const config = configSchema.parse({
    hub: {
      publicBaseUrl: publicOrigin,
      secureCookies: publicOrigin.startsWith("https:"),
      databasePath: ":memory:",
      resultsPath: root,
    },
    auth: {},
    machines: [
      {
        id: "pc",
        name: "PC",
        type: "ssh-windows",
        ssh: { target: "unused" },
        codex: { desktopControl: "C:/Control/Fixed.ps1" },
      },
    ],
    projects: [{ id: "project", name: "Project", machineId: "pc", workingDirectory: "C:/Project" }],
  });
  const store = new Store(":memory:"),
    calls = [],
    desktopCalls = [];
  let loseAck = false;
  const rpc = Object.assign(new EventEmitter(), {
    closed: false,
    initialize: async () => ({}),
    close() {
      this.closed = true;
    },
    async request(method, params) {
      calls.push({ method, params });
      const capabilities = capabilityReply(method);
      if (capabilities) return capabilities;
      if (method === "account/read") return { account: { type: "chatgpt" } };
      if (method === "thread/read") return { thread: { id: params.threadId, turns: [] } };
      if (method === "thread/resume") return { thread: { id: params.threadId, turns: [] } };
      if (method === "turn/start") {
        if (loseAck) throw new Error("lost native acknowledgement");
        const turn = { id: randomUUID(), status: "inProgress" };
        this.emit("notification", "turn/started", { threadId: params.threadId, turn });
        return { turn };
      }
      return { data: [] };
    },
  });
  const sessions = new Sessions(config, store, () => rpc);
  sessions.externalActivity.refresh = async () => {};
  const nativePrepare = sessions.attachments.prepare.bind(sessions.attachments);
  sessions.attachments.prepare = (_config, ...args) =>
    nativePrepare(
      { ...config, machines: [{ ...config.machines[0], type: "local-linux" }] },
      ...args,
    );
  const thread = store.createThread("project", randomUUID(), "Handoff chat");
  store.db.prepare("UPDATE threads SET origin='desktop' WHERE id=?").run(thread.id);
  store.setPreferences({ machineClients: { pc: "desktop" } });
  const setupToken = randomBytes(32).toString("base64url");
  let running = true,
    operation = null;
  const { app, push } = await createApp(config, {
    store,
    sessions,
    setupToken,
    webRoot,
    ...appOptions,
    desktopTransport: async (_m, action, id) => {
      desktopCalls.push(action);
      if (action === "ForceRelease") {
        running = false;
        operation = {
          id,
          kind: "forcerelease",
          state: "completed",
          code: "DESKTOP_RELEASED",
          requestedAt: Date.now() / 1000,
        };
      }
      return { available: true, running, activityKnown: true, activeTasks: 0, operation };
    },
  });
  const password = "Isolated handoff " + randomUUID();
  const enrolled = await app.inject({
    method: "POST",
    url: "/api/auth/setup",
    headers: { origin: publicOrigin },
    payload: { token: setupToken, password },
  });
  assert.equal(enrolled.statusCode, 200);
  const cookie = enrolled.headers["set-cookie"].split(";")[0];
  const session = await app.inject({ url: "/api/auth/session", headers: { cookie } });
  const headers = { origin: publicOrigin, cookie, "x-csrf-token": session.json().csrf };
  return {
    app,
    rpc,
    push,
    store,
    sessions,
    thread,
    calls,
    desktopCalls,
    headers,
    password,
    finishTurn: () => {
      rpc.emit("notification", "turn/completed", {
        threadId: thread.codexThreadId,
        turn: { id: store.thread(thread.id).activeTurnId, status: "completed" },
      });
    },
    loseAck: () => {
      loseAck = true;
    },
    send: (key, body) =>
      app.inject({
        method: "POST",
        url: `/api/threads/${thread.id}/turns`,
        headers: { ...headers, "idempotency-key": key },
        payload: body,
      }),
    release: () =>
      app.inject({
        method: "POST",
        url: "/api/machines/pc/client",
        headers: { ...headers, "idempotency-key": randomUUID() },
        payload: { client: "web", releaseDesktop: true, confirmStopTasks: true },
      }),
    close: async () => {
      await app.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
