import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createApp } from "../apps/hub/dist/app.js";
import { Sessions } from "../apps/hub/dist/sessions.js";
import { Store } from "../apps/hub/dist/store.js";
import { teamPasswordHash } from "../apps/hub/dist/team-auth.js";
import { createTeamHub } from "../apps/hub/dist/team-hub.js";
import { configSchema } from "../packages/shared/dist/index.js";
import { capabilityReply } from "./fixtures.mjs";

export async function communicationFixture() {
  const root = await mkdtemp(join(tmpdir(), "cw-spaces-ui-")),
    probe = createServer();
  await new Promise((done) => probe.listen(0, "127.0.0.1", done));
  const port = probe.address().port;
  await new Promise((done) => probe.close(done));
  const base = `http://127.0.0.1:${port}`,
    password = randomBytes(24).toString("base64url");
  const config = configSchema.parse({
    hub: {
      publicBaseUrl: base,
      secureCookies: false,
      databasePath: join(root, "owner.db"),
      resultsPath: join(root, "files"),
    },
    team: { enabled: true, root: join(root, "team") },
    auth: { username: "owner" },
    machines: [],
    projects: [],
  });
  const store = new Store(config.hub.databasePath);
  store.db.prepare("INSERT INTO users VALUES(?,?)").run("owner", await teamPasswordHash(password));
  const runtimes = new Map();
  const hub = await createTeamHub(config, {
    store,
    socketRoot: join(root, "sock"),
    webRoot: resolve("apps/web/dist"),
    personalFactory: async (selected, options) => {
      const who = selected.auth.username,
        path = join(root, who);
      await mkdir(path, { recursive: true });
      execFileSync("git", ["init", "-q", path]);
      execFileSync("git", [
        "-C",
        path,
        "remote",
        "add",
        "origin",
        `https://github.com/example/${who === "owner" ? "altar" : "world"}.git`,
      ]);
      const extra = join(root, who + "-extra");
      await mkdir(extra);
      execFileSync("git", ["init", "-q", extra]);
      execFileSync("git", [
        "-C",
        extra,
        "remote",
        "add",
        "origin",
        `https://github.com/example/${who === "owner" ? "assets" : "altar"}.git`,
      ]);
      const cfg = configSchema.parse({
        ...selected,
        machines: [{ id: "pc", name: "Local", type: "local-linux", allowedRoots: [root] }],
        projects: [
          {
            id: who + "-extra",
            name: who === "owner" ? "Assets" : "Altar copy",
            machineId: "pc",
            workingDirectory: extra,
          },
          {
            id: who + "-project",
            name: who === "owner" ? "Altar" : "World",
            machineId: "pc",
            workingDirectory: path,
          },
        ],
      });
      const personalStore = options.store ?? new Store(cfg.hub.databasePath);
      const nativeId = randomUUID(),
        thread = personalStore.createThread(
          who + "-project",
          nativeId,
          "Existing " + who + " chat",
        );
      const nativeCalls = [];
      personalStore.createThread(who + "-extra", randomUUID(), "Personal " + who + " chat");
      const rpc = Object.assign(new EventEmitter(), {
        closed: false,
        initialize: async () => ({}),
        close() {
          this.closed = true;
        },
        async request(method, params) {
          nativeCalls.push({ method, params });
          if (method === "thread/start") return { thread: { id: randomUUID() } };
          if (method === "turn/start") return { turn: { id: randomUUID(), status: "inProgress" } };
          const capabilities = capabilityReply(method);
          if (capabilities) return capabilities;
          if (method === "account/read") return { account: { type: "chatgpt" } };
          if (method === "thread/read" || method === "thread/resume")
            return { thread: { id: params.threadId, turns: [] } };
          return { data: [], nextCursor: null };
        },
      });
      const sessions = new Sessions(cfg, personalStore, () => rpc);
      sessions.externalActivity.refresh = async () => {};
      const runtime = await createApp(cfg, { ...options, sessions, store: personalStore });
      runtimes.set(who, { ...runtime, thread, nativeId, nativeCalls });
      return runtime;
    },
  });
  await hub.app.listen({ host: "127.0.0.1", port });
  const friend = hub.registry.accept(
    hub.registry.invite(hub.registry.ownerId, "Друг").token,
    "friend",
    "Друг",
    await teamPasswordHash(password),
    10,
  );
  hub.registry.db
    .prepare("INSERT INTO team_meta(key,value) VALUES(?,?)")
    .run(`onboarding:${friend.id}`, "deferred");

  const third = hub.registry.accept(
    hub.registry.invite(hub.registry.ownerId, "Третий").token,
    "third",
    "Третий",
    await teamPasswordHash(password),
    10,
  );
  const session = (id) => {
    const s = hub.registry.issueSession(id);
    return {
      cookie: `codex-session=${s.token}`,
      "x-workspace-id": id,
      "x-csrf-token": s.csrf,
      origin: base,
    };
  };
  const owner = hub.registry.ownerId;
  const headers = session(owner),
    friendHeaders = session(friend.id),
    thirdHeaders = session(third.id);
  const request = (headers, method, url, body, key = randomUUID()) =>
    hub.app.inject({
      method,
      url,
      headers: { ...headers, "idempotency-key": key },
      ...(body === undefined ? {} : { payload: body }),
    });
  return {
    hub,
    root,
    config,
    store,
    runtimes,
    base,
    password,
    friend: friend.id,
    third: third.id,
    owner,
    headers,
    friendHeaders,
    thirdHeaders,
    request,
    close: async () => {
      await hub.app.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
