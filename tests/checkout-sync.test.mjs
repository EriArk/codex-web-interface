import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { deliveryFixture, deliveryState } from "./delivery-fixture.mjs";

const base = "/api/projects/project/delivery";
const request = (f, method, url, body) =>
  f.app.inject({ method, url, headers: f.headers, payload: body });
const scope = {
  spaceId: "space",
  projectId: "shared",
  ownerId: "owner",
  ownerProjectId: "owner-project",
  participantId: "member",
  repository: "https://github.com/owner/project",
  access: "collaborate",
};
export const state = () => ({
  ...deliveryState(),
  changed: 0,
  paths: [],
  sync: {
    status: "behind",
    baseRef: "refs/heads/main",
    baseSha: "b".repeat(40),
    commonSha: "a".repeat(40),
    repositoryId: 73,
    githubUserId: 42,
    gitDirectory: "/work/.git",
    commonDirectory: "/work/.git",
    ahead: 0,
    behind: 2,
    conflicts: [],
    conflictsTotal: 0,
  },
});
test("managed copy persists exact provenance and revocation blocks both sync and pending Codex review", async (t) => {
  let granted = true;
  const f = await deliveryFixture(undefined, {
    collaborationPolicy: {
      instructions: () => null,
      delivery: () => {},
      checkoutScope: () => (granted ? scope : null),
    },
  });
  t.after(f.close);
  await f.release();
  f.setState(state());
  const seen = (await request(f, "GET", base)).json();
  assert.equal(seen.checkout.ownerId, "owner");
  assert.equal(seen.checkout.ownerProjectId, "owner-project");
  assert.equal(seen.checkout.baseline.baseSha, "b".repeat(40));
  const original = seen.checkout;
  f.setState({ ...state(), head: "d".repeat(40) });
  assert.deepEqual((await request(f, "GET", base)).json().checkout, original);
  const input = {
      kind: "sync",
      syncScope: original.scope,
      paths: [],
      message: "",
      title: "",
      body: "",
    },
    id = randomUUID();
  const prepared = await request(f, "PUT", base + "/" + id, input);
  assert.equal(prepared.statusCode, 200, prepared.body);
  const actionId = randomUUID(),
    action = await request(f, "PUT", "/api/workspace/actions/" + actionId, {
      kind: "checkout_reconcile",
      scope: { client: "codex", projectId: "project", name: "Project" },
      observationId: seen.id,
    });
  assert.equal(action.statusCode, 200, action.body);
  assert.match(action.json().text, /Не изменяй файлы/);
  f.setState({ ...state(), sync: { status: "unavailable", conflicts: [], conflictsTotal: 0 } });
  assert.deepEqual((await request(f, "GET", base)).json().checkout, original);
  granted = false;
  assert.equal(
    (
      await request(f, "POST", base + "/" + id + "/execute", {
        confirm: true,
        fingerprint: prepared.json().fingerprint,
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (await request(f, "POST", "/api/workspace/actions/" + actionId + "/submit", { confirm: true }))
      .statusCode,
    409,
  );
  assert.equal((await request(f, "PUT", base + "/" + randomUUID(), input)).statusCode, 409);
  const unavailable = (await request(f, "GET", base)).json();
  assert.equal(unavailable.checkoutUnavailable, true);
  assert.equal(f.deliveryCalls.filter((c) => c.request.op === "apply").length, 0);
  assert.equal(f.calls.filter((c) => c.method === "turn/start").length, 0);
  granted = true;
  f.setState({ ...state(), sync: { ...state().sync, githubUserId: 999 } });
  assert.equal((await request(f, "GET", base)).statusCode, 409);
});
test("personal projects cannot adopt a forged managed scope, and reads cannot leak after access changes", async (t) => {
  const f = await deliveryFixture();
  t.after(f.close);
  assert.equal(
    (
      await request(f, "PUT", base + "/" + randomUUID(), {
        kind: "sync",
        syncScope: "a".repeat(64),
        paths: [],
        message: "",
        title: "",
        body: "",
      })
    ).statusCode,
    409,
  );
  assert.equal(f.deliveryCalls.length, 0);
  const unauth = await f.app.inject({ method: "GET", url: base });
  assert.equal(unauth.statusCode, 401);
});
