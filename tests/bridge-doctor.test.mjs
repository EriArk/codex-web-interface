import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { BridgeDoctor, doctorState } from "../apps/hub/dist/bridge-doctor.js";
import { ProjectContext } from "../apps/hub/dist/project-context.js";
import { GPT_BRIDGE_REVISION } from "../packages/shared/dist/index.js";
import { handoffFixture } from "./handoff-fixture.mjs";

const report = (state = "healthy", extra = {}) => ({
  contract: 1,
  bridgeRevision: GPT_BRIDGE_REVISION,
  bridgeVersion: "6.3.14",
  extensionProtocol: 5,
  state,
  login: "authenticated",
  capabilities: {
    composer: true,
    attachments: true,
    models: true,
    effort: true,
    settingsReadback: true,
  },
  privateState: { permissions: true, locked: true },
  doctorObstruction: "clear",
  ...extra,
});
async function fixture(t) {
  const f = await handoffFixture();
  t.after(() => f.close());
  let now = 100000;
  const gpt = {
      json: async () => ({ kind: "omitted" }),
      available: () => true,
      doctorReport: async () => report(),
    },
    doctor = new BridgeDoctor(f.sessions, gpt, () => now, "abcdef123");
  doctor.configure(true, "project", 0);
  const fault = () => {
    now += 60001;
    doctor.observe(report("degraded"));
    now += 25000;
    doctor.observe(report("degraded"));
    now += 25000;
    return doctor.observe(report("degraded"));
  };
  return { f, doctor, gpt, fault, advance: (n) => (now += n), now: () => now };
}
test("Doctor debounces faults, deduplicates safe fingerprints, resolves after sustained health and preserves history", async (t) => {
  const { doctor, fault, advance } = await fixture(t);
  for (const state of ["busy", "starting", "login_required", "healthy"])
    doctor.observe(report(state));
  assert.equal(doctor.list().length, 0);
  const first = fault();
  assert(first);
  assert.equal(doctor.list().length, 1);
  advance(15000);
  doctor.observe(report("degraded"));
  assert.equal(doctor.list()[0].occurrences, 4);
  doctor.observe(report("healthy"));
  advance(30001);
  doctor.observe(report("healthy"));
  assert.equal(doctor.list()[0].state, "recovered");
  assert.equal(doctor.list()[0].delivery, "skipped");
  const again = fault();
  assert(again);
  assert.notEqual(again.id, first.id);
  assert.equal(again.previousId, first.id);
  const safe = doctorState(
    report("incompatible", {
      accessToken: "private-token",
      cookie: "owner-cookie",
      rawDom: "private conversation",
      bridgeVersion: "secret@example.com",
      doctorStage: "url-with-token",
      doctorObstruction: "unknown",
    }),
    "bad-secret",
  );
  assert(!JSON.stringify(safe).includes("private"));
  assert(!JSON.stringify(safe).includes("secret"));
  assert.equal(safe.bridgeVersion, "unknown");
});
test("Doctor ignores owner-controlled dialogs, login and recovered one-off failures", async (t) => {
  const { doctor, advance } = await fixture(t);
  advance(70000);
  for (const raw of [
    report("attention", { doctorObstruction: "owner" }),
    report("attention"),
    report("incompatible", { login: "required", bridgeVersion: "9.0.0" }),
    report("busy"),
    report("starting"),
  ]) {
    for (let n = 0; n < 6; n++) {
      advance(15000);
      doctor.observe(raw);
    }
  }
  assert.equal(doctor.list().length, 0);
  doctor.observe(null);
  advance(10000);
  doctor.observe(report());
  advance(60000);
  doctor.observe(report());
  assert.equal(doctor.list().length, 0);
});
test("Doctor creates one dedicated read-only native chat and send without changing Current or preferences", async (t) => {
  const { f, doctor, gpt, fault } = await fixture(t);
  const base = f.rpc.request.bind(f.rpc);
  f.rpc.request = async (method, params) => {
    if (method === "thread/start") {
      f.calls.push({ method, params });
      return { thread: { id: randomUUID(), historyMode: "paginated" } };
    }
    return base(method, params);
  };
  const context = new ProjectContext(f.sessions, gpt),
    scope = { client: "codex", projectId: "project", name: "Project" },
    before = context.current(scope),
    preferences = { ...f.store.preferences() };
  const incident = fault();
  await doctor.dispatch();
  assert.equal(f.calls.filter((c) => c.method === "thread/start").length, 0); // desktop choice is respected
  await f.release();
  const clients = { ...f.store.preferences() };
  await doctor.dispatch();
  assert.equal(doctor.list()[0].delivery, "sent");
  const association = doctor.association();
  assert(association.threadId);
  assert.notEqual(association.threadId, before.threadId);
  assert.equal(context.current(scope).threadId, before.threadId);
  assert.deepEqual(f.store.preferences(), clients);
  const create = f.calls.filter((c) => c.method === "thread/start"),
    send = f.calls.filter((c) => c.method === "turn/start");
  assert.equal(create.length, 1);
  assert.equal(send.length, 1);
  assert.equal(create[0].params.sandbox, "read-only");
  assert.deepEqual(send[0].params.sandboxPolicy, { type: "readOnly" });
  assert.equal(send[0].params.approvalPolicy, "never");
  assert.equal(send[0].params.clientUserMessageId, incident.id);
  assert.match(send[0].params.input[0].text, /Запрещено менять файлы/);
  await doctor.dispatch();
  assert.equal(f.calls.filter((c) => c.method === "turn/start").length, 1);
});
test("lost Doctor creation/send acknowledgements cannot create or submit a second native operation", async (t) => {
  const { f, doctor, gpt, fault, now } = await fixture(t);
  await f.release();
  fault();
  let creates = 0;
  f.sessions.create = async () => {
    creates++;
    throw Error("lost creation ack");
  };
  await doctor.dispatch();
  assert.equal(doctor.association().state, "unknown");
  await doctor.dispatch();
  assert.equal(creates, 1);
  const afterRestart = new BridgeDoctor(f.sessions, gpt, now, "abcdef123");
  await afterRestart.dispatch();
  assert.equal(creates, 1);
  // Bind only an explicit separate idle thread; never the Current chat.
  assert.throws(() => afterRestart.bind(f.thread.id), /отдельный/);
  const recovered = f.store.createThread("project", randomUUID(), "Bridge Doctor");
  afterRestart.bind(recovered.id);
  f.loseAck();
  await afterRestart.dispatch();
  assert.equal(afterRestart.list()[0].delivery, "unknown");
  assert.equal(f.calls.filter((c) => c.method === "turn/start").length, 1);
  await afterRestart.dispatch();
  assert.equal(f.calls.filter((c) => c.method === "turn/start").length, 1);
});

test("disabling Doctor during native creation is durable and blocks its pending diagnostic send", async (t) => {
  const { f, doctor, fault } = await fixture(t);
  await f.release();
  fault();
  let reached;
  const started = new Promise((resolve) => {
    reached = resolve;
  });
  let finish;
  const waiting = new Promise((resolve) => {
    finish = resolve;
  });
  f.sessions.create = async () => {
    reached();
    await waiting;
    return f.store.createThread("project", randomUUID(), "Bridge Doctor");
  };
  const running = doctor.dispatch();
  await started;
  const before = doctor.association();
  doctor.configure(false, before.projectId, before.revision);
  finish();
  await running;
  assert.equal(doctor.association().enabled, false);
  assert.equal(doctor.association().state, "ready");
  assert.equal(f.calls.filter((c) => c.method === "turn/start").length, 0);
  assert.equal(doctor.list()[0].delivery, "pending");
  const old = doctor.association();
  assert.throws(() => doctor.configure(true, "", old.revision), /Привязка сохранена/);
  assert.equal(doctor.association().threadId, old.threadId);
});
