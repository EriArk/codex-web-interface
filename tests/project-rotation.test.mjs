import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { ProjectCores } from "../apps/hub/dist/project-core.js";
import { handoffFixture } from "./handoff-fixture.mjs";

const scope = { client: "codex", projectId: "project", name: "Project" };
const req = async (f, method, url, payload) => {
  const r = await f.app.inject({ method, url, headers: f.headers, payload });
  return { status: r.statusCode, data: r.json() };
};
async function fixture() {
  const f = await handoffFixture();
  await f.release();
  const base = f.rpc.request.bind(f.rpc);
  f.rpc.request = async (method, p) => {
    if (method === "thread/start") {
      f.calls.push({ method, params: p });
      return { thread: { id: randomUUID(), historyMode: "paginated" } };
    }
    return base(method, p);
  };
  return f;
}
const current = async (f) =>
  (await req(f, "GET", "/api/workspace/current?client=codex&projectId=project")).data;
const prepare = async (f) => {
  const id = randomUUID(),
    r = await req(f, "PUT", "/api/workspace/actions/" + id, { scope, kind: "rotate" });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
};
test("rotation retains Core and bounded handoff, switches only after a confirmed ordinary bootstrap and preserves old links", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const cores = new ProjectCores(f.sessions),
    old = cores.get(scope);
  cores.save({
    ...old,
    value: {
      ...old.value,
      purpose: "Книги дома",
      rules: "Не удалять книги",
      constraints: "Только локальное хранение",
    },
  });
  f.store.append(
    f.thread.id,
    "assistant.completed",
    {
      id: "previous-answer",
      text: "Проверено меню. Синхронизация ещё не завершена.",
      phase: "final",
    },
    "old-turn",
  );
  const before = await current(f),
    a = await prepare(f);
  assert.equal(a.state, "prepared");
  assert.equal((await current(f)).threadId, before.threadId);
  assert.match(a.text, /Не удалять книги/);
  assert.match(a.text, /Синхронизация ещё не завершена/);
  assert.match(a.text, /динамическ/);
  assert(a.text.length <= 32000);
  const r = await req(f, "POST", `/api/workspace/actions/${a.id}/submit`, { confirm: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const after = await current(f);
  assert.notEqual(after.threadId, before.threadId);
  assert.equal(after.threadId, r.data.threadId);
  assert.equal(after.history[0].threadId, before.threadId);
  assert.equal(f.calls.filter((c) => c.method === "thread/start").length, 1);
  assert.equal(f.calls.filter((c) => c.method === "turn/start").length, 1);
  await req(f, "POST", `/api/workspace/actions/${a.id}/submit`, { confirm: true });
  assert.equal(f.calls.filter((c) => c.method === "thread/start").length, 1);
  const oldSource = await req(f, "POST", "/api/workspace/resolve", {
    client: "codex",
    kind: "thread",
    id: before.threadId,
    threadId: before.threadId,
    messageId: "previous-answer",
    projectId: "project",
    title: "Источник",
  });
  assert.notEqual(oldSource.data.availability, "missing");
  assert.equal(cores.get(scope).revision, 1);
  const report = await req(f, "PUT", "/api/workspace/actions/" + randomUUID(), {
    scope,
    kind: "report",
  });
  assert.equal(report.data.threadId, after.threadId);
});
test("a lost create acknowledgement keeps the old Current pointer and never blindly creates again", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const a = await prepare(f),
    base = f.rpc.request.bind(f.rpc);
  let created = 0;
  f.rpc.request = async (m, p) => {
    if (m === "thread/start") {
      created++;
      throw Error("lost creation receipt");
    }
    return base(m, p);
  };
  await req(f, "POST", `/api/workspace/actions/${a.id}/submit`, { confirm: true });
  assert.equal((await req(f, "GET", `/api/workspace/actions/${a.id}`)).data.state, "unknown");
  assert.equal((await current(f)).threadId, f.thread.id);
  await req(f, "POST", `/api/workspace/actions/${a.id}/submit`, { confirm: true });
  const b = await prepare(f);
  assert.equal(b.id, a.id);
  assert.equal(created, 1);
});
test("a lost bootstrap acknowledgement keeps the new identity without switching Current until exact native evidence arrives", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const a = await prepare(f);
  f.loseAck();
  await req(f, "POST", `/api/workspace/actions/${a.id}/submit`, { confirm: true });
  let run = (await req(f, "GET", `/api/workspace/actions/${a.id}`)).data;
  assert.equal(run.state, "unknown");
  assert(run.snapshot.newThreadId);
  assert.equal((await current(f)).threadId, f.thread.id);
  await req(f, "POST", `/api/workspace/actions/${a.id}/submit`, { confirm: true });
  assert.equal(f.calls.filter((c) => c.method === "thread/start").length, 1);
  assert.equal(f.calls.filter((c) => c.method === "turn/start").length, 1);
  const tid = randomUUID();
  f.store.append(run.threadId, "user.message", { id: a.id, text: a.text }, tid);
  run = (await req(f, "GET", `/api/workspace/actions/${a.id}`)).data;
  assert.equal(run.state, "running");
  assert.equal((await current(f)).threadId, run.threadId);
});
test("rotation rejects a changed Core or active old turn without native effects", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const a = await prepare(f),
    core = new ProjectCores(f.sessions),
    v = core.get(scope);
  core.save({ ...v, value: { ...v.value, rules: "Новые правила" } });
  let r = await req(f, "POST", `/api/workspace/actions/${a.id}/submit`, { confirm: true });
  assert.equal(r.data.error.code, "ROTATION_CONTEXT_CHANGED");
  const b = await prepare(f);
  f.store.setStatus(f.thread.id, "running", randomUUID());
  r = await req(f, "POST", `/api/workspace/actions/${b.id}/submit`, { confirm: true });
  assert.equal(r.data.error.code, "ROTATION_CHAT_BUSY");
  assert.equal(f.calls.filter((c) => c.method === "thread/start").length, 0);
});

test("GPT rotation persists the project send and requires canonical membership and matching bootstrap before rebinding", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const { GptService } = await import("../apps/hub/dist/gpt.js");
  const { ProjectActions } = await import("../apps/hub/dist/project-actions.js");
  const gpt = new GptService(f.sessions.config, f.store);
  t.after(() => gpt.close());
  gpt.available = () => true;
  gpt.pump = async () => {};
  gpt.models = async () => ({ currentModel: "Latest", currentEffort: "2" });
  const projectId = "g-p-" + randomUUID(),
    oldId = randomUUID(),
    newId = randomUUID(),
    scope = { client: "gpt", projectId, name: "GPT project" };
  gpt.library.save("project", projectId, { name: scope.name });
  gpt.library.save("thread", oldId, { name: "Old chat", projectId, activityAt: 1 });
  const actions = new ProjectActions(f.sessions, gpt, {}),
    a = await actions.prepare(randomUUID(), { scope, kind: "rotate" });
  await actions.submit(a.id);
  await actions.submit(a.id);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM gpt_jobs").get().n, 1);
  assert.equal(
    f.store.db.prepare("SELECT projectId FROM gpt_project_jobs WHERE jobId=?").get(a.id).projectId,
    projectId,
  );
  assert.equal(actions.context.current(scope).threadId, oldId);
  f.store.db
    .prepare(
      "UPDATE gpt_jobs SET nativeId=?,status='completed',submitted=1,answer='Context received' WHERE id=?",
    )
    .run(newId, a.id);
  const node = (id, parent, role, text) => ({
    id,
    parent,
    message: {
      id,
      author: { role },
      channel: role === "assistant" ? "final" : undefined,
      content: { content_type: "text", parts: [text] },
      create_time: Date.now() / 1000,
      status: "finished_successfully",
      metadata: { is_complete: true },
    },
  });
  let correct = false;
  gpt.json = async () => ({
    gizmo_id: correct ? projectId : "wrong-project",
    title: "Next chat",
    current_node: "final",
    mapping: {
      user: node("user", null, "user", a.text),
      final: node("final", "user", "assistant", "Context received"),
    },
  });
  await gpt.verifyProjectJob(a.id);
  assert.equal(actions.get(a.id).state, "unknown");
  assert.equal(actions.context.current(scope).threadId, oldId);
  correct = true;
  f.store.db.prepare("UPDATE gpt_project_jobs SET checkedAt=0 WHERE jobId=?").run(a.id);
  await gpt.verifyProjectJob(a.id);
  const done = actions.get(a.id);
  assert.equal(done.state, "completed");
  assert.equal(actions.context.current(scope).threadId, newId);
  assert.equal(actions.context.current(scope).history[0].threadId, oldId);
  const report = await actions.prepare(randomUUID(), { scope, kind: "report" });
  assert.equal(report.threadId, newId);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM gpt_jobs").get().n, 1);
});

test("maximal Core remains intact in a bounded bootstrap and two prepared receipts cannot launch twice", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const cores = new ProjectCores(f.sessions),
    base = cores.get(scope);
  cores.save({
    ...base,
    value: Object.fromEntries(Object.keys(base.value).map((k) => [k, k + " " + "я".repeat(2980)])),
  });
  for (let i = 0; i < 35; i++)
    f.store.append(
      f.thread.id,
      "assistant.completed",
      { id: "long-" + i, text: "Ответ ".repeat(400), phase: "final" },
      "prior-" + i,
    );
  const a = await prepare(f),
    b = await prepare(f);
  assert.notEqual(a.id, b.id);
  assert(a.text.length <= 32000);
  assert(a.text.includes("я".repeat(2980)));
  await Promise.all([
    req(f, "POST", `/api/workspace/actions/${a.id}/submit`, { confirm: true }),
    req(f, "POST", `/api/workspace/actions/${b.id}/submit`, { confirm: true }),
  ]);
  assert.equal(f.calls.filter((c) => c.method === "thread/start").length, 1);
  assert.equal(f.calls.filter((c) => c.method === "turn/start").length, 1);
});
test("an explicitly abandoned uncertain rotation keeps the old project pointer without replaying work", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const a = await prepare(f),
    base = f.rpc.request.bind(f.rpc);
  f.rpc.request = async (m, p) => {
    if (m === "thread/start") throw Error("unknown");
    return base(m, p);
  };
  await req(f, "POST", `/api/workspace/actions/${a.id}/submit`, { confirm: true });
  assert.equal(
    (await req(f, "POST", `/api/workspace/actions/${a.id}/keep-current`, {})).status,
    400,
  );
  const r = await req(f, "POST", `/api/workspace/actions/${a.id}/keep-current`, { confirm: true });
  assert.equal(r.data.state, "cancelled");
  assert.equal((await current(f)).threadId, f.thread.id);
  assert.equal(f.calls.filter((c) => c.method === "turn/start").length, 0);
});
