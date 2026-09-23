import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { handoffFixture, settings } from "./handoff-fixture.mjs";

const scope = { client: "codex", projectId: "project", name: "Project" };
const body = (text = "Изучи задачу", revision = 0) => ({ text, revision, sources: [], settings });
async function fixture(t) {
  const f = await handoffFixture();
  t.after(() => f.close());
  await f.release();
  const rpc = f.rpc.request.bind(f.rpc);
  f.rpc.request = async (method, params) => {
    if (method === "thread/start") {
      f.calls.push({ method, params });
      return { thread: { id: randomUUID(), historyMode: "paginated" } };
    }
    return rpc(method, params);
  };
  f.finishIntake = () => {
    const s = f.intake.get("project"),
      thread = f.store.thread(s.threadId),
      turnId = thread.activeTurnId;
    f.sessions.emitEvent(
      thread.id,
      "assistant.completed",
      {
        id: "answer-" + turnId,
        text: "Интерпретация. План. Риски. Проверки.",
        phase: "final_answer",
      },
      turnId,
    );
    f.rpc.emit("notification", "turn/completed", {
      threadId: thread.codexThreadId,
      turn: { id: turnId, status: "completed" },
    });
    return { thread, turnId, messageId: "answer-" + turnId };
  };
  return f;
}
test("Intake reuses one read-only native chat, hides utility navigation, and never replaces Current", async (t) => {
  const f = await fixture(t),
    key = randomUUID();
  const state = await f.intake.send("project", key, body());
  assert.notEqual(state.threadId, f.thread.id);
  assert.equal(f.projectWork.context.current(scope).threadId, f.thread.id);
  const create = f.calls.find((c) => c.method === "thread/start");
  assert.equal(create.params.sandbox, "read-only");
  assert.equal(create.params.approvalPolicy, "never");
  const turn = f.calls.find((c) => c.method === "turn/start");
  assert.deepEqual(turn.params.sandboxPolicy, { type: "readOnly" });
  assert.equal(turn.params.approvalPolicy, "never");
  assert.equal(state.messages[0].text, "Изучи задачу");
  assert.equal(
    f.store.threads("project").some((v) => v.id === state.threadId),
    true,
    "active maintenance still sees utility work",
  );
  const list = await f.app.inject({ url: "/api/projects/project/threads", headers: f.headers });
  assert.equal(list.statusCode, 200);
  assert(!list.body.includes(state.threadId));
  await f.intake.send("project", key, body());
  assert.equal(f.calls.filter((c) => c.method === "turn/start").length, 1);
  f.finishIntake();
  await f.intake.send("project", randomUUID(), body("Уточни проверку"));
  assert.equal(f.calls.filter((c) => c.method === "thread/start").length, 1);
  assert.equal(f.calls.filter((c) => c.method === "turn/start").length, 2);
});
test("utility cannot gain write settings, use ordinary sends/queue/forks/resume or become Current", async (t) => {
  const f = await fixture(t),
    s = await f.intake.send("project", randomUUID(), body());
  f.finishIntake();
  for (const operation of [
    () => f.sessions.setSettings(s.threadId, { ...settings, access: "full" }),
    () => f.sessions.queueClient(s.threadId),
    () => f.sessions.resume(s.threadId),
    () => f.sessions.fork(s.threadId),
    () => f.sessions.startTurn(s.threadId, "write", settings),
  ])
    await assert.rejects(operation, /технический чат/);
  assert.throws(() => f.projectWork.context.adopt(scope, s.threadId));
  assert.equal(f.calls.filter((c) => c.method === "turn/start").length, 1);
});
test("lost native creation acknowledgement blocks replacement and every later creation attempt", async (t) => {
  const f = await fixture(t),
    rpc = f.rpc.request.bind(f.rpc);
  let creates = 0;
  f.rpc.request = async (m, p) => {
    if (m === "thread/start") {
      creates++;
      throw Error("lost create ACK");
    }
    return rpc(m, p);
  };
  await assert.rejects(() => f.intake.send("project", randomUUID(), body()));
  assert.equal(f.intake.get("project").creationUnknown, true);
  await assert.rejects(() => f.intake.send("project", randomUUID(), body("другая задача")));
  await assert.rejects(() => f.intake.recover("project", null, 0));
  assert.equal(creates, 1);
});
test("creation receipt survives a later naming failure without making another native chat", async (t) => {
  const f = await fixture(t),
    rpc = f.rpc.request.bind(f.rpc);
  let lost = true;
  f.rpc.request = async (m, p) => {
    if (m === "thread/name/set" && lost) {
      lost = false;
      throw Error("lost name ACK");
    }
    return rpc(m, p);
  };
  await f.intake.send("project", randomUUID(), body()).catch(() => {});
  const s = f.intake.get("project");
  assert(s.threadId);
  assert(!s.creationUnknown);
  if (s.status === "idle") await f.intake.send("project", randomUUID(), body("продолжи"));
  assert.equal(f.calls.filter((c) => c.method === "thread/start").length, 1);
});
test("lost native send acknowledgement stays unknown and is never replayed", async (t) => {
  const f = await fixture(t);
  f.loseAck();
  const key = randomUUID();
  const s = await f.intake.send("project", key, body());
  assert.equal(s.status, "unknown");
  await f.intake.send("project", key, body());
  await f.intake.send("project", randomUUID(), body("новый запрос")).catch(() => {});
  assert.equal(f.calls.filter((c) => c.method === "turn/start").length, 1);
});
test("frozen scope rejects revocation and changed checkout; explicit recovery retains old history", async (t) => {
  const f = await fixture(t);
  let grant = 1;
  f.intake.authority = () => grant;
  const caps = f.sessions.capabilities.bind(f.sessions);
  f.sessions.capabilities = async (id) => {
    const c = await caps(id);
    grant = 2;
    return c;
  };
  await assert.rejects(() =>
    f.intake.send("project", randomUUID(), { text: "read", sources: [], revision: 0 }),
  );
  assert.equal(f.calls.filter((c) => c.method === "turn/start").length, 0);
  f.sessions.capabilities = caps;
  const s = await f.intake.send("project", randomUUID(), body());
  f.finishIntake();
  f.sessions.project("project").workingDirectory = "C:/Changed";
  assert.equal(f.intake.get("project").status, "missing");
  await assert.rejects(() => f.intake.send("project", randomUUID(), body()));
  const replaced = await f.intake.recover("project", null, s.revision);
  assert.equal(replaced.threadId, null);
  assert.equal(replaced.revision, 1);
  assert(f.store.thread(s.threadId));
});
test("reviewed handoff freezes exact answer/source and uses existing explicit Work confirmation once", async (t) => {
  const f = await fixture(t);
  f.intake.inspect = async () => ({ remote: { url: "https://github.com/owner/repo.git" } });
  f.intake.probe = async (_m, _p, q) => ({
    access: "write",
    repository: "owner/repo",
    repositoryId: 42,
    identity: { id: 7, login: "me" },
    query: q.query,
    evidence: { source: q.query.source, text: "Exact evidence", truncated: false },
  });
  const s = await f.intake.send("project", randomUUID(), { ...body(), sources: ["issue:42"] });
  const done = f.finishIntake(),
    key = randomUUID(),
    packet = {
      messageId: done.messageId,
      text: "Отредактированный план и проверка",
      revision: s.revision,
    };
  const a = await f.intake.handoff("project", key, packet);
  assert.equal(a.threadId, f.thread.id);
  assert.match(a.text, /Отредактированный/);
  assert.match(a.text, /https:\/\/github.com\/owner\/repo\/issues\/42/);
  assert.equal(
    f.calls.filter((c) => c.method === "turn/start").length,
    1,
    "preparing handoff is not a native send",
  );
  assert.equal((await f.intake.handoff("project", key, packet)).id, a.id);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM project_plans").get().n, 1);
  const send = () =>
    f.app.inject({
      method: "POST",
      url: `/api/workspace/actions/${a.id}/submit`,
      headers: f.headers,
      payload: { confirm: true },
    });
  assert.equal((await send()).statusCode, 200);
  assert.equal((await send()).statusCode, 200);
  assert.equal(f.calls.filter((c) => c.method === "turn/start").length, 2);
  assert.equal(
    f.calls.filter((c) => c.method === "turn/start")[1].params.threadId,
    f.thread.codexThreadId,
  );
});
test("foreign evidence and mismatched viewer records are rejected before any native send", async (t) => {
  const f = await fixture(t);
  f.intake.inspect = async () => ({ remote: { url: "git@github.com:owner/repo.git" } });
  f.intake.probe = async () => ({
    access: "read",
    repository: "foreign/repo",
    repositoryId: 9,
    identity: { id: 7 },
    evidence: { source: "issue:42", text: "secret" },
  });
  await assert.rejects(() =>
    f.intake.send("project", randomUUID(), { ...body(), sources: ["issue:42"] }),
  );
  f.intake.probe = async () => ({
    access: "read",
    repository: "owner/repo",
    repositoryId: 42,
    identity: { id: 7 },
    record: { type: "issue", number: 41 },
  });
  await assert.rejects(() => f.intake.source("project", "issue:42"));
  await assert.rejects(() =>
    f.intake.source("project", "issue:42", 1, {
      url: "https://github.com/old/repo/issues/42",
      repositoryId: 42,
    }),
  );
  await assert.rejects(() =>
    f.intake.source("project", "issue:42", 1, {
      url: "https://github.com/owner/repo/issues/42",
      repositoryId: 99,
    }),
  );
  assert.equal(f.calls.filter((c) => c.method === "turn/start").length, 0);
});
test("unknown send recovery cannot match an unrelated native turn, even with identical text", async (t) => {
  const f = await fixture(t);
  f.loseAck();
  const key = randomUUID();
  const state = await f.intake.send("project", key, body());
  const original = f.rpc.request.bind(f.rpc);
  const prompt = f.store.history(state.threadId).messages[0].text;
  f.rpc.request = async (m, p) =>
    m === "thread/resume"
      ? {
          thread: {
            id: p.threadId,
            turns: [
              {
                id: randomUUID(),
                status: "completed",
                items: [
                  {
                    id: randomUUID(),
                    type: "userMessage",
                    content: [{ type: "text", text: prompt }],
                  },
                ],
              },
            ],
          },
        }
      : original(m, p);
  await f.sessions.resume(state.threadId, true);
  assert.equal(f.intake.get("project").status, "unknown");
  await f.intake.send("project", randomUUID(), body()).catch(() => {});
  assert.equal(f.calls.filter((c) => c.method === "turn/start").length, 1);
});
test("deleted native chat keeps its exact identity until explicit replacement", async (t) => {
  const f = await fixture(t),
    state = await f.intake.send("project", randomUUID(), body());
  f.finishIntake();
  const thread = f.store.thread(state.threadId);
  f.sessions.catalog.library.save("thread", thread.codexThreadId, {
    id: thread.codexThreadId,
    name: thread.title,
    projectId: "project",
    deleted: true,
  });
  assert.equal(f.intake.get("project").status, "missing");
  await assert.rejects(() => f.intake.send("project", randomUUID(), body()));
  assert.equal(f.calls.filter((c) => c.method === "thread/start").length, 1);
  const reset = await f.intake.recover("project", null, 0);
  assert.equal(reset.revision, 1);
  await f.intake.send("project", randomUUID(), body("Новый разбор", 1));
  assert.equal(f.calls.filter((c) => c.method === "thread/start").length, 2);
});
test("recovery cannot adopt another utility role", async (t) => {
  const f = await fixture(t);
  const doctor = f.store.createThread("project", randomUUID(), "Doctor");
  f.store.db.prepare("UPDATE threads SET diagnostic=1 WHERE id=?").run(doctor.id);
  await assert.rejects(() => f.intake.recover("project", doctor.codexThreadId, 0));
  assert.equal(f.intake.get("project").threadId, null);
});
