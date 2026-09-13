import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { tokenHash } from "../apps/hub/dist/auth.js";
import { engineInfo } from "../apps/hub/dist/engine-client.js";
import { Store } from "../apps/hub/dist/store.js";
import { teamPasswordHash } from "../apps/hub/dist/team-auth.js";
import { createTeamHub } from "../apps/hub/dist/team-hub.js";
import { configSchema } from "../packages/shared/dist/index.js";

test("team engine serves its Unix socket, preserves owner sessions and enforces login limits", {
  skip: process.platform === "win32",
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cw-team-uds-"));
  const config = configSchema.parse({
    hub: {
      publicBaseUrl: "https://codex.example.test",
      databasePath: join(root, "app.db"),
      resultsPath: join(root, "results"),
    },
    auth: { username: "owner", ownerLogin: "eriark" },
    team: { enabled: true, registrationEnabled: false, root: join(root, "team") },
    machines: [],
    projects: [],
  });
  const store = new Store(config.hub.databasePath),
    password = randomBytes(24).toString("base64url"),
    token = randomBytes(32).toString("base64url");
  store.db.prepare("INSERT INTO users VALUES(?,?)").run("owner", await teamPasswordHash(password));
  store.db
    .prepare("INSERT INTO sessions VALUES(?,?,?)")
    .run(tokenHash(token), "fixture-csrf", Date.now() + 60000);
  const hub = await createTeamHub(config, {
    store,
    socketRoot: join(root, "users"),
    executionService: true,
  });
  t.after(async () => {
    await hub.app.close();
    await rm(root, { recursive: true, force: true });
  });
  const socketPath = join(root, "engine.sock");
  await hub.app.listen({ path: socketPath });
  const call = (path, body, extra = {}) =>
    new Promise((resolve, reject) => {
      const req = request(
        {
          socketPath,
          path,
          method: body ? "POST" : "GET",
          headers: {
            origin: config.hub.publicBaseUrl,
            "content-type": "application/json",
            ...extra,
          },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => {
            data += chunk;
          });
          res.on("error", reject);
          res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
        },
      );
      req.on("error", reject);
      req.end(body ? JSON.stringify(body) : undefined);
    });
  const info = await engineInfo(socketPath);
  assert.equal(info.team, 1);
  assert.equal(info.ownerReady, true);
  assert.equal(info.registrationEnabled, false);
  assert.equal((await call("/api/health")).status, 200);
  const old = await call("/api/auth/session", undefined, {
    cookie: `__Host-codex-session=${token}`,
  });
  assert.equal(old.status, 200);
  assert.equal(old.body.user.login, "eriark");
  assert(old.body.originalOwner);
  const login = await call("/api/auth/login", { login: "eriark", password });
  assert.equal(login.status, 200);
  assert.equal(login.body.user.id, old.body.user.id);
  for (let i = 0; i < 4; i++)
    assert.equal(
      (await call("/api/auth/login", { login: "eriark", password: "incorrect-password" })).status,
      401,
    );
  assert.equal(
    (
      await call(
        "/api/auth/login",
        { login: "eriark", password },
        { "x-forwarded-for": "203.0.113.1" },
      )
    ).status,
    429,
  );
  assert.equal((await engineInfo(socketPath)).instance, info.instance);
});
