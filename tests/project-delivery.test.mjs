import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { HubError } from "../packages/shared/dist/index.js";
import { deliveryFixture, deliveryInput } from "./delivery-fixture.mjs";

const request = async (f, method, path, body) => {
  const r = await f.app.inject({ method, url: "/api" + path, headers: f.headers, payload: body });
  return { status: r.statusCode, data: r.json() };
};
const base = "/projects/project/delivery";
test("publication rechecks collaboration policy after preparation before any apply", async (t) => {
  let allowed = true;
  const f = await deliveryFixture(undefined, {
    collaborationPolicy: {
      instructions: () => null,
      delivery: () => {
        if (!allowed)
          throw new HubError(409, "SPACE_WORKING_BRANCH_REQUIRED", "Use a working branch");
      },
    },
  });
  t.after(() => f.close());
  const op = await prepare(f);
  allowed = false;
  assert.equal(
    (
      await request(f, "POST", base + "/" + op.id + "/execute", {
        confirm: true,
        fingerprint: op.fingerprint,
      })
    ).status,
    409,
  );
  assert.equal(f.deliveryCalls.filter((c) => c.request.op === "apply").length, 0);
  assert.equal((await request(f, "GET", base + "/" + op.id)).data.state, "prepared");
  allowed = true;
  assert.equal(
    (
      await request(f, "POST", base + "/" + op.id + "/execute", {
        confirm: true,
        fingerprint: op.fingerprint,
      })
    ).status,
    202,
  );
  assert.equal((await settle(f, op)).state, "completed");
});
async function prepare(f) {
  const id = randomUUID(),
    r = await request(f, "PUT", base + "/" + id, deliveryInput);
  assert.equal(r.status, 200, JSON.stringify(r));
  return r.data;
}
async function settle(f, op) {
  let r;
  for (let i = 0; i < 20; i++) {
    r = await request(f, "GET", base + "/" + op.id);
    if (r.data.state !== "running") return r.data;
    await new Promise((r) => setTimeout(r, 10));
  }
  return r.data;
}
test("delivery reads and preparation never acquire a writer; confirm and retry preserve one operation", async (t) => {
  const f = await deliveryFixture();
  t.after(() => f.close());
  const before = f.calls.length;
  assert.equal((await request(f, "GET", base)).data.state.branch, "feature/mobile");
  const op = await prepare(f);
  assert.equal(f.calls.length, before);
  assert.equal((await request(f, "POST", base + "/" + op.id + "/execute", {})).status, 400);
  const body = { confirm: true, fingerprint: op.fingerprint };
  assert.equal((await request(f, "POST", base + "/" + op.id + "/execute", body)).status, 202);
  assert.equal((await settle(f, op)).state, "completed");
  assert.equal(
    (await request(f, "POST", base + "/" + op.id + "/execute", body)).data.state,
    "completed",
  );
  assert.equal(f.deliveryCalls.filter((c) => c.request.op === "apply").length, 1);
  assert(f.deliveryCalls.every((c) => c.root === "C:/Project" && c.machine === "pc"));
  assert.equal(
    (await request(f, "PUT", base + "/" + op.id, { ...deliveryInput, message: "Different" }))
      .status,
    409,
  );
  const noAuth = await f.app.inject({
    method: "PUT",
    url: "/api" + base + "/" + randomUUID(),
    payload: deliveryInput,
  });
  assert.equal(noAuth.statusCode, 401);
  const noCsrf = await f.app.inject({
    method: "PUT",
    url: "/api" + base + "/" + randomUUID(),
    headers: { cookie: f.headers.cookie, origin: f.headers.origin },
    payload: deliveryInput,
  });
  assert.equal(noCsrf.statusCode, 403);
});
test("unknown worker acknowledgement reconciles the recorded commit without applying twice", async (t) => {
  const f = await deliveryFixture();
  t.after(() => f.close());
  const op = await prepare(f);
  f.loseDeliveryAck();
  await request(f, "POST", base + "/" + op.id + "/execute", {
    confirm: true,
    fingerprint: op.fingerprint,
  });
  const done = await settle(f, op);
  assert.equal(done.state, "completed");
  assert.equal(done.commit, "b".repeat(40));
  assert.equal(f.deliveryCalls.filter((c) => c.request.op === "apply").length, 1);
});
test("active work blocks delivery and active delivery blocks concurrent project sends", async (t) => {
  const f = await deliveryFixture();
  t.after(() => f.close());
  await f.release();
  const op = await prepare(f),
    body = { confirm: true, fingerprint: op.fingerprint };
  f.store.setStatus(f.thread.id, "running", "turn");
  assert.equal((await request(f, "POST", base + "/" + op.id + "/execute", body)).status, 409);
  f.store.setStatus(f.thread.id, "idle");
  const release = f.hold();
  await request(f, "POST", base + "/" + op.id + "/execute", body);
  assert.throws(() => f.sessions.assertWritable("project"), /Git/);
  const other = await prepare(f);
  assert.equal(
    (
      await request(f, "POST", base + "/" + other.id + "/execute", {
        confirm: true,
        fingerprint: other.fingerprint,
      })
    ).status,
    409,
  );
  release();
  await settle(f, op);
  assert.doesNotThrow(() => f.sessions.assertWritable("project"));
});
test("project reassignment and unknown receipt mismatch cannot authorize another root", async (t) => {
  const f = await deliveryFixture();
  t.after(() => f.close());
  const op = await prepare(f);
  const original = f.sessions.project.bind(f.sessions);
  f.sessions.project = (id) => ({ ...original(id), workingDirectory: "C:/Other" });
  assert.equal(
    (
      await request(f, "POST", base + "/" + op.id + "/execute", {
        confirm: true,
        fingerprint: op.fingerprint,
      })
    ).status,
    409,
  );
  assert.equal(f.deliveryCalls.filter((c) => c.request.op === "apply").length, 0);
  f.sessions.project = original;
  f.store.db
    .prepare(
      "UPDATE delivery_operations SET state='unknown',value=json_set(value,'$.state','unknown') WHERE id=?",
    )
    .run(op.id);
  f.receipts.get(op.id).fingerprint = "0".repeat(64);
  assert.equal((await request(f, "GET", base + "/" + op.id)).data.state, "unknown");
});
test("failed CI prepares exact immutable evidence for Current Chat and submits once only after confirmation", async (t) => {
  const f = await deliveryFixture();
  t.after(() => f.close());
  await f.release();
  const seen = (await request(f, "GET", base)).data,
    id = randomUUID();
  const body = {
    kind: "ci_fix",
    scope: { client: "codex", projectId: "project", name: "Project" },
    observationId: seen.id,
  };
  const prepared = await request(f, "PUT", "/workspace/actions/" + id, body);
  assert.equal(prepared.status, 200, JSON.stringify(prepared));
  assert.equal(prepared.data.threadId, f.thread.id);
  assert.match(prepared.data.text, /aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/);
  assert.match(prepared.data.text, /Browser \/ WebKit/);
  assert.equal(f.calls.filter((c) => c.method === "turn/start").length, 0);
  for (let i = 0; i < 2; i++)
    assert.equal(
      (await request(f, "POST", "/workspace/actions/" + id + "/submit", { confirm: true })).status,
      200,
    );
  assert.equal(f.calls.filter((c) => c.method === "turn/start").length, 1);
  f.finishTurn();
  f.setState({
    ...f.state(),
    github: { ...f.state().github, checks: [{ name: "Hub", state: "passed" }] },
  });
  const green = (await request(f, "GET", base)).data;
  assert.equal(
    (
      await request(f, "PUT", "/workspace/actions/" + randomUUID(), {
        ...body,
        observationId: green.id,
      })
    ).status,
    409,
  );
});
