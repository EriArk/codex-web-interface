import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { deploymentBlockers } from "../apps/hub/dist/deployment-status.js";
import { preparationFixture } from "./project-preparation-fixture.mjs";

async function fixture(t) {
  const f = await preparationFixture();
  t.after(() => f.close());
  return f;
}
test("settled discussion generates only a reviewed proposal, explicit collision choice then typed branch/files/PR plus existing Issue publisher", async (t) => {
  const f = await fixture(t),
    p = await f.create();
  assert.equal(p.state, "draft");
  assert.equal(p.files[0].choice, "ask");
  assert.equal(p.files[0].oldText, "# Existing\r\n");
  assert.equal(f.operations.length, 0);
  assert.match(f.sends[0].input.text, /Settled exact discussion/);
  await assert.rejects(f.service.review("project", p.id, p.revision), /изменились/);
  p.files[0].choice = "replace";
  const saved = await f.save(p),
    review = await f.service.review("project", p.id, saved.revision);
  assert.equal(f.operations.length, 0);
  assert.equal(review.state, "review");
  f.service.confirm("project", p.id, review.fingerprint);
  await Promise.all(f.service.pending.values());
  const result = await f.service.get("project", p.id);
  assert.equal(result.state, "complete", result.error);
  assert.equal(result.result.pr, 12);
  assert.equal(result.issueResults[0].state, "completed");
  const mutations = f.operations.filter((q) => q.op === "apply");
  assert.equal(mutations.length, 4);
  assert.deepEqual(
    f.operations.filter((q) => q.op === "prepare").map((q) => q.input.kind),
    ["preparation-branch", "preparation-files", "preparation-pr", "issue-create"],
  );
  f.service.confirm("project", p.id, review.fingerprint);
  assert.equal(f.operations.filter((q) => q.op === "apply").length, 4);
  const link = f.service.handoff("project", p.id, f.projectWork);
  const plan = f.projectWork.plans.get(link.id);
  assert.match(plan.description, /codexweb\/prepare/);
  assert.match(plan.description, /bbbbbbbb/);
  assert.equal(f.service.handoff("project", p.id, f.projectWork).id, link.id);
  assert.equal(f.calls.filter((c) => c.method === "turn/start").length, 0);
});
test("exact request identity, collision rename/skip, stale revisions, repository movement and identity binding", async (t) => {
  const f = await fixture(t),
    id = randomUUID();
  const first = await f.service.create("project", id, f.input);
  assert.equal((await f.service.create("project", id, f.input)).id, id);
  assert.equal(f.sends.length, 1);
  await assert.rejects(
    f.service.create("project", id, { ...f.input, brief: "Changed" }),
    /изменились/,
  );
  const p = await f.service.get("project", id);
  p.files[0].path = "docs/README-copy.md";
  p.files[0].choice = "create";
  p.files[1].choice = "skip";
  const saved = await f.save(p);
  assert.equal(saved.files[0].previous, null);
  await assert.rejects(f.save(p), /изменились/);
  await assert.rejects(f.save({ ...saved, files: [{ ...saved.files[0], path: "AGENTS.md" }] }));
  f.changeIdentity({ id: 99, login: "Other" });
  await assert.rejects(f.service.review("project", id, saved.revision), /изменились/);
  f.changeIdentity({ id: 7, login: "actual-user" });
  f.changeHead("c".repeat(40));
  await assert.rejects(f.service.review("project", id, saved.revision), /изменились/);
  assert.equal(f.operations.length, 0);
  assert.equal(first.state, "generating");
});
test("lost dispatch acknowledgement persists intent, status reconciles without replay and resume continues remaining steps", async (t) => {
  const f = await fixture(t),
    p = await f.create();
  p.files[0].choice = "skip";
  p.issues = [];
  const saved = await f.save(p),
    review = await f.service.review("project", p.id, saved.revision);
  const probe = f.service.probe;
  let lost = true;
  f.service.probe = async (...args) => {
    const r = await probe(...args);
    if (args[2].op === "apply" && lost) {
      lost = false;
      throw Error("Connection lost");
    }
    return r;
  };
  f.service.confirm("project", p.id, review.fingerprint);
  await Promise.all(f.service.pending.values());
  assert.equal((await f.service.get("project", p.id)).state, "paused");
  assert(deploymentBlockers(f.store).some((b) => b.kind === "project_preparation"));
  const count = f.operations.filter((q) => q.op === "apply").length;
  await f.service.reconcile("project", p.id);
  assert.equal(f.operations.filter((q) => q.op === "apply").length, count);
  f.service.confirm("project", p.id, review.fingerprint);
  await Promise.all(f.service.pending.values());
  assert.equal((await f.service.get("project", p.id)).state, "complete");
  assert.equal(f.operations.filter((q) => q.op === "apply").length, 3);
});
test("private routes require session; invalid proposal stays editable; cancellation never writes", async (t) => {
  const f = await fixture(t);
  const unauthorized = await f.app.inject({ url: "/api/projects/project/preparation" });
  assert.equal(unauthorized.statusCode, 401);
  f.changeProposal({ bad: "invalid" });
  const p = await f.create();
  assert.equal(p.state, "draft");
  assert.match(p.error, /вручную/);
  const cancelled = f.service.cancel("project", p.id, p.revision);
  assert.equal(cancelled.state, "cancelled");
  assert.equal(f.operations.length, 0);
  assert.equal((await f.request("GET", "/" + p.id)).statusCode, 200);
  const cross = await f.app.inject({
    url: "/api/projects/second/preparation/" + p.id,
    headers: f.headers,
  });
  assert.equal(cross.statusCode, 404);
});

test("changed Issue actor after file publication cannot borrow the package approval", async (t) => {
  const f = await fixture(t),
    p = await f.create();
  p.files[0].choice = "skip";
  const saved = await f.save(p),
    review = await f.service.review("project", p.id, saved.revision);
  const native = f.d.probe;
  f.d.probe = async (...args) => {
    const r = await native(...args);
    if (args[2].op === "prepare") r.snapshot.identity = { id: 99, login: "other" };
    return r;
  };
  f.service.confirm("project", p.id, review.fingerprint);
  await Promise.all(f.service.pending.values());
  const result = await f.service.get("project", p.id);
  assert.equal(result.state, "paused");
  assert.equal(f.operations.filter((q) => q.op === "apply").length, 3);
  assert.equal(f.d.batch(result.issueBatchId).state, "cancelled");
});
test("recovery records survive service restart and never resume writes automatically", async (t) => {
  const f = await fixture(t),
    p = await f.create();
  p.files[0].choice = "skip";
  p.issues = [];
  const saved = await f.save(p),
    review = await f.service.review("project", p.id, saved.revision);
  const native = f.service.probe;
  f.service.probe = async (...args) => {
    if (args[2].op === "apply") throw Error("Lost before ACK");
    return native(...args);
  };
  f.service.confirm("project", p.id, review.fingerprint);
  await Promise.all(f.service.pending.values());
  const count = f.operations.length;
  const { ProjectPreparations } = await import("../apps/hub/dist/project-preparation.js");
  const restarted = new ProjectPreparations(
    f.sessions,
    f.gpt,
    f.projectGpts,
    f.d,
    native,
    f.d.inspect,
  );
  assert.equal((await restarted.get("project", p.id)).state, "paused");
  assert.equal(f.operations.length, count);
  await restarted.close();
});

test("explicit continuation retries only known rejection and preserves prior receipts", async (t) => {
  const f = await fixture(t),
    p = await f.create();
  p.files[0].choice = "skip";
  p.issues = [];
  const saved = await f.save(p),
    review = await f.service.review("project", p.id, saved.revision),
    native = f.service.probe;
  let reject = true;
  f.service.probe = async (...args) => {
    const q = args[2];
    if (q.op === "apply" && reject) {
      reject = false;
      const r = f.receipts.get(q.id);
      r.state = "failed";
      r.code = "GITHUB_WORK_REJECTED";
      return structuredClone(r);
    }
    return native(...args);
  };
  f.service.confirm("project", p.id, review.fingerprint);
  await Promise.all(f.service.pending.values());
  assert.equal((await f.service.get("project", p.id)).state, "paused");
  f.service.confirm("project", p.id, review.fingerprint);
  await Promise.all(f.service.pending.values());
  assert.equal((await f.service.get("project", p.id)).state, "complete");
  const savedReceipt = JSON.parse(
    f.store.db.prepare("SELECT value FROM project_preparations WHERE id=?").get(p.id).value,
  );
  assert.equal(savedReceipt.steps[0].attempts[0].state, "failed");
});
test("a malformed completed native receipt cannot authorize later steps", async (t) => {
  const f = await fixture(t),
    p = await f.create();
  p.files[0].choice = "skip";
  p.issues = [];
  const saved = await f.save(p),
    review = await f.service.review("project", p.id, saved.revision),
    native = f.service.probe;
  f.service.probe = async (...args) => {
    const r = await native(...args);
    if (args[2].op === "apply") r.result.sha = "wrong";
    return r;
  };
  f.service.confirm("project", p.id, review.fingerprint);
  await Promise.all(f.service.pending.values());
  assert.equal((await f.service.get("project", p.id)).state, "paused");
  assert.equal(f.operations.filter((q) => q.op === "apply").length, 1);
});
