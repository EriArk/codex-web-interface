import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { handoffFixture as fixture } from "./handoff-fixture.mjs";

async function handoffFixture() {
  const f = await fixture();
  await f.release();
  return f;
}

const scope = { client: "codex", projectId: "project", name: "Project" };
const plan = () => ({
  scope,
  title: "План интерфейса",
  description: "Сохранить функции",
  sections: [
    {
      id: randomUUID(),
      title: "Навигация",
      items: [
        { id: randomUUID(), text: "Уже работает", checked: true },
        { id: randomUUID(), text: "Добавить жест", checked: false },
      ],
    },
  ],
  links: [],
  revision: 0,
  status: "draft",
});
const request = async (f, method, url, payload) => {
  const res = await f.app.inject({ method, url, headers: f.headers, payload });
  return { status: res.statusCode, data: res.json() };
};
async function prepare(f, kind = "plan") {
  let p;
  if (kind === "plan") {
    const id = randomUUID();
    p = (await request(f, "PUT", "/api/workspace/plans/" + id, plan())).data;
    assert.equal(p.revision, 1);
  }
  const id = randomUUID(),
    body = { scope, kind, ...(p ? { planId: p.id, planRevision: p.revision } : {}) };
  const prepared = await request(f, "PUT", "/api/workspace/actions/" + id, body);
  assert.equal(prepared.status, 200, JSON.stringify(prepared.data));
  return { id, p, body, action: prepared.data };
}
test("plans keep ordered checked state, explicit revisions, Unicode search and exact save retry", async (t) => {
  const f = await handoffFixture();
  t.after(() => f.close());
  const id = randomUUID(),
    p = plan();
  assert.equal((await request(f, "PUT", "/api/workspace/plans/" + id, p)).data.revision, 1);
  assert.equal((await request(f, "PUT", "/api/workspace/plans/" + id, p)).data.revision, 1);
  const items = (
    await request(f, "GET", "/api/workspace/plans?q=" + encodeURIComponent("ИНТЕРФЕЙСА"))
  ).data.items;
  assert.equal(items.length, 1);
  assert.equal(items[0].checked, 1);
  assert.equal(items[0].total, 2);
  assert(!("sections" in items[0]));
  assert.equal(
    (await request(f, "PUT", "/api/workspace/plans/" + id, { ...p, title: "Перезапись" })).status,
    409,
  );
  assert.equal(
    (await request(f, "DELETE", "/api/workspace/plans/" + id, { revision: 0, confirm: true }))
      .status,
    400,
  );
  assert.equal(f.calls.filter((c) => c.method === "turn/start").length, 0);
});
test("confirmed plan enters the ordinary Codex pipeline once, binds the native turn and preserves human tasks", async (t) => {
  const f = await handoffFixture();
  t.after(() => f.close());
  const { id, body, action } = await prepare(f);
  assert.equal(action.threadId, f.thread.id);
  assert.match(action.text, /Уже сделано \/ существующее состояние/);
  assert.match(action.text, /Выполнить: Добавить жест/);
  assert.equal(f.calls.filter((c) => c.method === "turn/start").length, 0);
  assert.equal((await request(f, "POST", `/api/workspace/actions/${id}/submit`, {})).status, 400);
  const result = await request(f, "POST", `/api/workspace/actions/${id}/submit`, { confirm: true });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(
    (await request(f, "POST", `/api/workspace/actions/${id}/submit`, { confirm: true })).status,
    200,
  );
  assert.equal(f.calls.filter((c) => c.method === "turn/start").length, 1);
  assert.equal(f.calls.find((c) => c.method === "turn/start").params.clientUserMessageId, id);
  const turnId = result.data.turnId;
  assert(turnId);
  f.store.append(
    f.thread.id,
    "assistant.completed",
    { id: "answer", text: "Проверено, готово", phase: "final" },
    turnId,
  );
  f.finishTurn();
  const done = (await request(f, "GET", `/api/workspace/actions/${id}`)).data;
  assert.equal(done.state, "completed");
  assert.equal(done.source.messageId, id);
  assert.equal(done.source.turnId, turnId);
  assert.equal(
    (await request(f, "PUT", `/api/workspace/actions/${id}`, body)).data.state,
    "completed",
  );
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM workspace_tasks").get().n, 0);
});
test("a lost native acknowledgement is durable unknown and never replayed, including another device", async (t) => {
  const f = await handoffFixture();
  t.after(() => f.close());
  const { id, p } = await prepare(f);
  f.loseAck();
  await request(f, "POST", `/api/workspace/actions/${id}/submit`, { confirm: true });
  assert.equal((await request(f, "GET", `/api/workspace/actions/${id}`)).data.state, "unknown");
  assert.equal(
    (await request(f, "POST", `/api/workspace/actions/${id}/submit`, { confirm: true })).status,
    409,
  );
  const other = await request(f, "PUT", `/api/workspace/actions/${randomUUID()}`, {
    scope,
    kind: "plan",
    planId: p.id,
    planRevision: p.revision,
  });
  assert.equal(other.data.id, id);
  assert.equal(f.calls.filter((c) => c.method === "turn/start").length, 1);
  assert.equal(
    (await request(f, "DELETE", `/api/workspace/plans/${p.id}`, { revision: 1, confirm: true }))
      .status,
    409,
  );
});
test("work ownership rejection preserves a prepared plan and the same receipt after explicit handoff", async (t) => {
  const f = await handoffFixture();
  t.after(() => f.close());
  const { id } = await prepare(f);
  await f.sessions.setMachineClient("pc", "desktop");
  const blocked = await request(f, "POST", `/api/workspace/actions/${id}/submit`, {
    confirm: true,
  });
  assert.equal(blocked.data.error.code, "MACHINE_RELEASED");
  assert.equal((await request(f, "GET", `/api/workspace/actions/${id}`)).data.state, "blocked");
  assert.equal(f.calls.filter((c) => c.method === "turn/start").length, 0);
  await f.release();
  assert.equal(
    (await request(f, "POST", `/api/workspace/actions/${id}/submit`, { confirm: true })).status,
    200,
  );
  assert.equal(f.calls.filter((c) => c.method === "turn/start").length, 1);
});
test("reports advance their durable checkpoint only with confirmed completion and saved visible final text", async (t) => {
  const f = await handoffFixture();
  t.after(() => f.close());
  const initial = f.store.result(
    f.thread.id,
    "prior",
    "result-prior",
    "check",
    "Старая проверка",
    {},
  );
  f.store.setPreferences({
    ...f.store.preferences(),
    projectGit: {
      project: {
        root: f.sessions.project("project").workingDirectory,
        repository: true,
        branch: "main",
        dirty: true,
        changed: 3,
        checkedAt: 123,
      },
    },
  });
  const { id, action } = await prepare(f, "report");
  assert.deepEqual(action.snapshot.context.cachedGit, {
    repository: true,
    branch: "main",
    dirty: true,
    changed: 3,
    checkedAt: 123,
  });
  assert(action.snapshot.context.results.some((r) => r.id === initial));
  assert.equal((await request(f, "GET", "/api/workspace/reports")).data.items.length, 0);
  const running = (
    await request(f, "POST", `/api/workspace/actions/${id}/submit`, { confirm: true })
  ).data;
  const later = f.store.result(f.thread.id, "later", "later", "check", "Новая проверка", {});
  assert.equal((await request(f, "GET", "/api/workspace/reports")).data.items.length, 0);
  f.store.append(
    f.thread.id,
    "assistant.completed",
    { id: "report-final", text: "# Итог\nПроверено. Остался жест.", phase: "final" },
    running.turnId,
  );
  f.finishTurn();
  const report = (await request(f, "GET", "/api/workspace/reports")).data.items[0];
  assert.equal(report.id, id);
  const saved = (await request(f, "GET", `/api/workspace/reports/${id}`)).data;
  assert.equal(saved.body, "# Итог\nПроверено. Остался жест.");
  assert.equal(saved.source.messageId, "report-final");
  const next = await prepare(f, "report");
  assert.equal(next.action.snapshot.previousReportId, id);
  assert(next.action.snapshot.context.results.some((r) => r.id === later));
  assert(!next.action.snapshot.context.results.some((r) => r.id === initial));
  const run2 = (
    await request(f, "POST", `/api/workspace/actions/${next.id}/submit`, { confirm: true })
  ).data;
  f.rpc.emit("notification", "turn/completed", {
    threadId: f.thread.codexThreadId,
    turn: { id: run2.turnId, status: "failed" },
  });
  assert.equal((await request(f, "GET", `/api/workspace/actions/${next.id}`)).data.state, "failed");
  assert.equal((await request(f, "GET", "/api/workspace/reports")).data.items.length, 1);
});
test("active implementation uses the existing native queue with its stable user message identity", async (t) => {
  const f = await handoffFixture();
  t.after(() => f.close());
  const base = f.rpc.request.bind(f.rpc),
    queue = [];
  f.rpc.request = async (method, p) => {
    if (method === "thread/queue/list") return { data: queue };
    if (method === "thread/queue/delete") {
      const i = queue.findIndex((q) => q.id === p.queuedSubmissionId);
      if (i < 0) return { deleted: false };
      queue.splice(i, 1);
      return { deleted: true };
    }
    if (method === "thread/queue/add") {
      f.calls.push({ method, params: p });
      const q = { id: randomUUID(), clientUserMessageId: p.clientUserMessageId, input: p.input };
      queue.push(q);
      return { queuedSubmission: q };
    }
    return base(method, p);
  };
  const first = await prepare(f);
  await request(f, "POST", `/api/workspace/actions/${first.id}/submit`, { confirm: true });
  const second = await prepare(f);
  const result = await request(f, "POST", `/api/workspace/actions/${second.id}/submit`, {
    confirm: true,
  });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.state, "queued");
  assert.equal(queue.length, 1);
  assert.equal(queue[0].clientUserMessageId, second.id);
  await request(f, "POST", `/api/workspace/actions/${second.id}/submit`, { confirm: true });
  assert.equal(queue.length, 1);
  const q = (await request(f, "GET", `/api/threads/${f.thread.id}/queue`)).data.items[0];
  const removal = await f.app.inject({
    method: "POST",
    url: `/api/threads/${f.thread.id}/queue/${q.id}`,
    headers: { ...f.headers, "idempotency-key": randomUUID() },
    payload: { action: "delete", revision: q.revision },
  });
  assert.equal(removal.statusCode, 200);
  assert.equal(queue.length, 0);
  assert.equal(
    (await request(f, "GET", `/api/workspace/actions/${second.id}`)).data.state,
    "cancelled",
  );
});

test("report completion waits briefly for its final message and never checkpoints an empty answer", async (t) => {
  const f = await handoffFixture();
  t.after(() => f.close());
  const { id } = await prepare(f, "report");
  const run = (await request(f, "POST", `/api/workspace/actions/${id}/submit`, { confirm: true }))
    .data;
  f.finishTurn();
  assert.equal((await request(f, "GET", `/api/workspace/actions/${id}`)).data.state, "running");
  assert.equal((await request(f, "GET", "/api/workspace/reports")).data.items.length, 0);
  f.store.append(
    f.thread.id,
    "assistant.completed",
    { id: "late-final", text: "Финальный отчёт", phase: "final" },
    run.turnId,
  );
  assert.equal((await request(f, "GET", `/api/workspace/actions/${id}`)).data.state, "completed");
  assert.equal(
    (await request(f, "GET", `/api/workspace/reports/${id}`)).data.source.messageId,
    "late-final",
  );
});
test("workspace work mutations require the existing session and CSRF confirmation", async (t) => {
  const f = await handoffFixture();
  t.after(() => f.close());
  const id = randomUUID();
  assert.equal(
    (await f.app.inject({ method: "PUT", url: "/api/workspace/plans/" + id, payload: plan() }))
      .statusCode,
    401,
  );
  assert.equal(
    (
      await f.app.inject({
        method: "PUT",
        url: "/api/workspace/plans/" + id,
        headers: { cookie: f.headers.cookie, origin: f.headers.origin },
        payload: plan(),
      })
    ).statusCode,
    403,
  );
});

test("GPT reports never attach an identical older assistant message as the new report source", async (t) => {
  const f = await handoffFixture();
  t.after(() => f.close());
  const { GptService } = await import("../apps/hub/dist/gpt.js");
  const { ProjectActions } = await import("../apps/hub/dist/project-actions.js");
  const gpt = new GptService(f.sessions.config, f.store);
  t.after(() => gpt.close());
  gpt.available = () => true;
  gpt.pump = async () => {};
  gpt.models = async () => ({ currentModel: "Latest", currentEffort: "2" });
  const projectId = "g-p-" + randomUUID(),
    nativeId = randomUUID();
  const scope = { client: "gpt", projectId, name: "GPT project" };
  gpt.library.save("project", projectId, { name: scope.name });
  gpt.library.save("thread", nativeId, { name: "Current", projectId, activityAt: 1 });
  const actions = new ProjectActions(f.sessions, gpt, {});
  for (const recent of [false, true]) {
    const a = await actions.prepare(randomUUID(), { scope, kind: "report" });
    await actions.submit(a.id);
    f.store.db
      .prepare("UPDATE gpt_jobs SET status='completed',submitted=1,answer='Готово' WHERE id=?")
      .run(a.id);
    gpt.historyCache.peek = () => [
      {
        id: recent ? "new-final" : "old-final",
        role: "assistant",
        text: "Готово",
        createdAt: (Date.now() - (recent ? 0 : 3600000)) / 1000,
      },
    ];
    assert.equal(actions.get(a.id).state, "completed");
    const report = actions.context.report(a.id);
    assert.equal(report.source.messageId, recent ? "new-final" : undefined);
    assert.equal(report.body, "Готово");
  }
});

test("parallel preparation shares one receipt and survives project rename", async (t) => {
  const f = await handoffFixture();
  t.after(() => f.close());
  const { GptService } = await import("../apps/hub/dist/gpt.js");
  const { ProjectActions } = await import("../apps/hub/dist/project-actions.js");
  const gpt = new GptService(f.sessions.config, f.store);
  t.after(() => gpt.close());
  const projectId = "g-p-" + randomUUID(),
    nativeId = randomUUID(),
    scope = { client: "gpt", projectId, name: "Before" };
  gpt.library.save("project", projectId, { name: scope.name });
  gpt.library.save("thread", nativeId, { projectId, name: "Current" });
  let release;
  let calls = 0;
  const gate = new Promise((r) => (release = r));
  gpt.models = async () => {
    calls++;
    await gate;
    return { currentModel: "Latest", currentEffort: "2" };
  };
  const actions = new ProjectActions(f.sessions, gpt, {}),
    id = randomUUID();
  const first = actions.prepare(id, { scope, kind: "report" });
  const second = actions.prepare(id, { scope, kind: "report" });
  release();
  const both = await Promise.allSettled([first, second]);
  assert.deepEqual(
    both.map((r) => r.status),
    ["fulfilled", "fulfilled"],
  );
  assert.equal(calls, 1);
  const renamed = await actions.prepare(id, { scope: { ...scope, name: "After" }, kind: "report" });
  assert.equal(renamed.id, id);
  assert.equal(renamed.text, both[0].value.text);
  await assert.rejects(
    actions.prepare(id, { scope, kind: "rotate" }),
    (e) => e.code === "ACTION_KEY_REUSED",
  );
});

test("a missing Current can be explicitly repaired without sending or losing old links", async (t) => {
  const f = await handoffFixture();
  t.after(() => f.close());
  const { ProjectContext } = await import("../apps/hub/dist/project-context.js");
  const context = new ProjectContext(f.sessions, {});
  context.adopt(scope, f.thread.id);
  f.store.db.prepare("UPDATE threads SET archived=1 WHERE id=?").run(f.thread.id);
  const next = f.store.createThread("project", randomUUID(), "Replacement");
  assert.equal(context.current(scope).threadId, null);
  const body = { scope, threadId: next.id, revision: 1, confirm: true };
  for (const [headers, status] of [
    [{}, 401],
    [{ cookie: f.headers.cookie, origin: f.headers.origin }, 403],
  ]) {
    const response = await f.app.inject({
      method: "POST",
      url: "/api/workspace/current/restore",
      headers,
      payload: body,
    });
    assert.equal(response.statusCode, status);
  }
  const a = await request(f, "POST", "/api/workspace/current/restore", body);
  assert.equal(a.status, 200, JSON.stringify(a.data));
  assert.equal(a.data.threadId, next.id);
  assert.equal(a.data.revision, 2);
  assert(a.data.history.some((h) => h.threadId === f.thread.id));
  assert.equal((await request(f, "POST", "/api/workspace/current/restore", body)).data.revision, 2);
  assert.equal(
    (await request(f, "POST", "/api/workspace/current/restore", { ...body, threadId: f.thread.id }))
      .status,
    409,
  );
  assert.equal(f.calls.filter((c) => ["turn/start", "thread/start"].includes(c.method)).length, 0);
});

test("report context excludes cached Git observations from an old project directory", async (t) => {
  const f = await handoffFixture();
  t.after(() => f.close());
  f.store.setPreferences({
    projectGit: {
      project: {
        root: "C:\\previous",
        repository: true,
        branch: "old-branch",
        dirty: false,
        changed: 0,
        checkedAt: Date.now(),
      },
    },
  });
  const { action } = await prepare(f, "report");
  assert.equal(action.snapshot.context.cachedGit, undefined);
});

test("GPT Current repair respects membership and unresolved native receipts", async (t) => {
  const f = await handoffFixture();
  t.after(() => f.close());
  const { GptService } = await import("../apps/hub/dist/gpt.js");
  const { ProjectActions } = await import("../apps/hub/dist/project-actions.js");
  const gpt = new GptService(f.sessions.config, f.store);
  t.after(() => gpt.close());
  gpt.models = async () => ({ currentModel: "Latest", currentEffort: "2" });
  const projectId = "g-p-" + randomUUID(),
    oldId = randomUUID(),
    nextId = randomUUID(),
    wrongId = randomUUID();
  const scope = { client: "gpt", projectId, name: "GPT project" };
  gpt.library.save("project", projectId, { name: scope.name });
  gpt.library.save("thread", oldId, { name: "Current", projectId });
  gpt.library.save("thread", nextId, { name: "Replacement", projectId });
  gpt.library.save("thread", wrongId, { name: "Other project", projectId: "different" });
  const actions = new ProjectActions(f.sessions, gpt, {}),
    context = actions.context;
  context.adopt(scope, oldId);
  const action = await actions.prepare(randomUUID(), { scope, kind: "report" });
  f.store.db.prepare("UPDATE project_work_actions SET state='unknown' WHERE id=?").run(action.id);
  gpt.library.save("thread", oldId, { name: "Current", projectId, deleted: true });
  assert.throws(
    () => context.restoreCurrent(scope, wrongId, 1),
    (e) => e.code === "PROJECT_CHAT_CHANGED",
  );
  assert.throws(
    () => context.restoreCurrent(scope, nextId, 1),
    (e) => e.code === "PROJECT_ACTION_PENDING",
  );
  assert.equal(context.current(scope).revision, 1);
  f.store.db.prepare("UPDATE project_work_actions SET state='cancelled' WHERE id=?").run(action.id);
  assert.equal(context.restoreCurrent(scope, nextId, 1).threadId, nextId);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM gpt_jobs").get().n, 0);
  assert.equal(f.calls.length, 0);
});
