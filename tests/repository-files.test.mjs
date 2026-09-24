import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { deploymentBlockers } from "../apps/hub/dist/deployment-status.js";
import { registerRepositoryFiles } from "../apps/hub/dist/repository-files.js";
import Fastify from "../apps/hub/node_modules/fastify/fastify.js";
import { handoffFixture } from "./handoff-fixture.mjs";

test("repository editor persists intent, isolates source bindings, and reconciles unknown writes without replay", async (t) => {
  const f = await handoffFixture();
  t.after(() => f.close());
  const app = Fastify();
  t.after(() => app.close());
  let scope = { machineId: "pc", root: "C:/Project", authority: null },
    applies = 0,
    lost = false;
  const receipts = new Map();
  const observe = {
    repository: "Owner/Project",
    repositoryId: 51,
    identity: { id: 11, login: "Owner" },
    access: "write",
  };
  registerRepositoryFiles(
    app,
    f.sessions,
    { scope: () => ({ ...scope }) },
    async (_m, _r, q) => {
      if (q.op === "observe") return observe;
      if (q.op === "prepare") {
        const r = {
          id: q.id,
          input: q.input,
          fingerprint: "fingerprint",
          snapshot: observe,
          state: "prepared",
        };
        receipts.set(q.id, r);
        return r;
      }
      if (q.op === "apply") {
        applies++;
        receipts.get(q.id).state = "completed";
        if (lost) throw Error("lost acknowledgement");
      }
      return receipts.get(q.id) ?? null;
    },
    async () => ({ remote: { url: "https://github.com/Owner/Project.git" } }),
  );
  const call = (path, body = {}) =>
    app.inject({ method: "POST", url: "/api/projects/project/github-files" + path, payload: body });
  const read = await call("/read", { kind: "repository-files", branch: "main", path: "README.md" });
  assert.equal(read.statusCode, 200);
  const binding = read.json().binding;
  const id = randomUUID(),
    input = {
      kind: "repository-file",
      branch: "main",
      head: "a".repeat(40),
      title: "Manual",
      files: [{ path: "README.md", previous: "b".repeat(40), content: "YWJj" }],
    };
  const body = { input, binding, repositoryId: 51, identityId: 11 };
  assert.equal((await call(`/${id}/prepare`, body)).statusCode, 200);
  assert.equal(
    (await call(`/${id}/prepare`, { ...body, input: { ...input, title: "Changed" } })).statusCode,
    409,
  );
  assert.equal((await call(`/${id}/confirm`, { fingerprint: "wrong" })).statusCode, 409);
  assert.equal(applies, 0);
  lost = true;
  assert.equal((await call(`/${id}/confirm`, { fingerprint: "fingerprint" })).statusCode, 500);
  assert.equal(deploymentBlockers(f.store).find((v) => v.kind === "repository_file").count, 1);
  assert.equal((await call(`/${randomUUID()}/prepare`, body)).statusCode, 409);
  // Status survives a new request and a repeated confirm becomes a read.
  assert.equal((await call(`/${id}/status`)).json().state, "completed");
  assert.equal(
    (await call(`/${id}/confirm`, { fingerprint: "fingerprint" })).json().state,
    "completed",
  );
  assert.equal(applies, 1);
  assert(!deploymentBlockers(f.store).some((v) => v.kind === "repository_file"));
  const interrupted = randomUUID();
  const missing = {
    ...(await call(`/${interrupted}/prepare`, body)).json(),
    state: "preparing",
    receipt: undefined,
  };
  receipts.delete(interrupted);
  f.store.db
    .prepare("UPDATE repository_file_operations SET value=? WHERE id=?")
    .run(JSON.stringify(missing), interrupted);
  assert.equal((await call(`/${interrupted}/status`)).json().state, "failed");
  assert(!deploymentBlockers(f.store).some((v) => v.kind === "repository_file"));
  scope = { ...scope, root: "C:/Other" };
  assert.equal((await call(`/${id}/confirm`, { fingerprint: "fingerprint" })).statusCode, 409);
  assert.equal((await call(`/${randomUUID()}/prepare`, body)).statusCode, 409);
  assert.equal(applies, 1);
  const otherId = randomUUID(),
    otherBinding = createHash("sha256").update(JSON.stringify(scope)).digest("hex");
  assert.equal(
    (await call(`/${otherId}/prepare`, { ...body, binding: otherBinding, identityId: 99 }))
      .statusCode,
    409,
  );
});
