import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { WorkReviews } from "../apps/hub/dist/work-reviews.js";
import { handoffFixture } from "./handoff-fixture.mjs";

const scope = { client: "codex", projectId: "project", name: "Project" };
test("GPT review binds the exact completed job, preserves image-only results and never treats prose as a passed check", async (t) => {
  const f = await handoffFixture();
  t.after(() => f.close());
  const jobs = new Map(),
    reviews = new WorkReviews(f.sessions, { job: (id) => jobs.get(id) });
  const action = {
    id: randomUUID(),
    scope: { client: "gpt", projectId: "gpt-project", name: "GPT Project" },
    kind: "plan",
    state: "completed",
    threadId: randomUUID(),
    title: "Изображение",
    snapshot: {},
  };
  jobs.set(action.id, {
    nativeId: action.threadId,
    status: "unknown",
    answer: "Все проверки пройдены",
    assets: [],
  });
  assert.equal(reviews.capture(action), null);
  jobs.set(action.id, {
    nativeId: randomUUID(),
    status: "completed",
    answer: "Чужой ответ",
    assets: [],
  });
  assert.equal(reviews.capture(action), null);
  jobs.set(action.id, {
    nativeId: action.threadId,
    status: "completed",
    answer: "",
    assets: [{ id: "file-image", name: "Иллюстрация", image: true }],
  });
  const result = reviews.capture(action);
  assert.equal(result.jobId, action.id);
  assert.equal(result.evidence[0].target.threadId, action.threadId);
  assert.equal(reviews.summary(result).passed, 0);
  assert.equal(reviews.list("gpt:gpt-project").items.length, 1);
  assert.equal(reviews.list("codex:project").items.length, 0);
});
async function request(f, method, url, payload) {
  const res = await f.app.inject({ method, url, headers: f.headers, payload });
  return { status: res.statusCode, data: res.json() };
}
async function run(f) {
  const planId = randomUUID(),
    id = randomUUID();
  const p = {
    scope,
    title: "Проверить результат",
    description: "Не терять функции",
    sections: [
      {
        id: randomUUID(),
        title: "Работа",
        items: [{ id: randomUUID(), text: "Изменить интерфейс", checked: false }],
      },
    ],
    links: [],
    revision: 0,
    status: "draft",
  };
  assert.equal((await request(f, "PUT", "/api/workspace/plans/" + planId, p)).status, 200);
  assert.equal(
    (
      await request(f, "PUT", "/api/workspace/actions/" + id, {
        scope,
        kind: "plan",
        planId,
        planRevision: 1,
      })
    ).status,
    200,
  );
  const sent = await request(f, "POST", `/api/workspace/actions/${id}/submit`, { confirm: true });
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  return { id, planId, turnId: sent.data.turnId };
}
function finish(f, turnId, text = "Выполнено. Физический iPad не проверен.") {
  f.store.append(
    f.thread.id,
    "assistant.completed",
    { id: "final-" + turnId, text, phase: "final" },
    turnId,
  );
  f.finishTurn();
}
test("review freezes exact work, keeps technical evidence separate, and decisions are revisioned and idempotent", async (t) => {
  const f = await handoffFixture();
  t.after(() => f.close());
  await f.release();
  const a = await run(f);
  assert.equal((await request(f, "GET", "/api/workspace/reviews")).data.items.length, 0);
  const resultId = f.store.result(f.thread.id, a.turnId, "check1", "check", "Проверка", {
    command: "npm test",
    exitCode: 0,
  });
  finish(f, a.turnId);
  const list = (await request(f, "GET", "/api/workspace/reviews")).data;
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].passed, 1);
  assert(!("answer" in list.items[0]));
  const read = () => request(f, "GET", `/api/workspace/reviews/${a.id}`);
  const value = (await read()).data.review;
  assert.equal(value.source.messageId, "final-" + a.turnId);
  assert.equal(value.source.turnId, a.turnId);
  assert.equal(value.evidence[0].id, resultId);
  assert.equal(value.state, "pending");
  f.store.result(f.thread.id, a.turnId, "late", "check", "Позднее изменение", {
    command: "other",
    exitCode: 2,
  });
  assert.equal((await read()).data.review.evidence.length, 1);
  const input = { requestId: randomUUID(), revision: 1, decision: "accepted", note: "" };
  const url = `/api/workspace/reviews/${a.id}/decision`;
  assert.equal((await request(f, "POST", url, input)).data.revision, 2);
  assert.equal((await request(f, "POST", url, input)).data.revision, 2);
  assert.equal((await request(f, "POST", url, { ...input, note: "Changed" })).status, 409);
  assert.equal(
    (
      await request(f, "POST", url, {
        ...input,
        requestId: randomUUID(),
        decision: "needs_fixes",
        note: "Fix",
      })
    ).status,
    409,
  );
  assert.equal(
    (await request(f, "GET", `/api/workspace/plans/${a.planId}`)).data.sections[0].items[0].checked,
    false,
  );
  assert.equal(f.calls.filter((c) => c.method === "turn/start").length, 1);
  assert.equal((await f.app.inject({ method: "POST", url, payload: input })).statusCode, 401);
});
test("corrections use Current chat with review identity, reject stale decisions and preserve lost send outcomes", async (t) => {
  const f = await handoffFixture();
  t.after(() => f.close());
  await f.release();
  const a = await run(f);
  finish(f, a.turnId);
  await request(f, "GET", `/api/workspace/reviews/${a.id}`);
  assert.equal(
    (
      await request(f, "POST", `/api/workspace/reviews/${a.id}/decision`, {
        requestId: randomUUID(),
        revision: 1,
        decision: "needs_fixes",
        note: "Кнопка не работает",
      })
    ).status,
    200,
  );
  const id = randomUUID(),
    body = { scope, kind: "correction", reviewId: a.id, reviewRevision: 2 };
  const p = await request(f, "PUT", "/api/workspace/actions/" + id, body);
  assert.equal(p.status, 200, JSON.stringify(p.data));
  assert.match(p.data.text, /Кнопка не работает/);
  assert.match(p.data.text, /Не запускай исходное задание/);
  assert.equal(p.data.snapshot.reviewId, a.id);
  const changed = await request(f, "POST", `/api/workspace/reviews/${a.id}/decision`, {
    requestId: randomUUID(),
    revision: 2,
    decision: "accepted",
    note: "",
  });
  assert.equal(changed.status, 200);
  assert.equal(
    (await request(f, "POST", `/api/workspace/actions/${id}/submit`, { confirm: true })).status,
    409,
  );
  assert.equal(f.calls.filter((c) => c.method === "turn/start").length, 1);
  await request(f, "POST", `/api/workspace/reviews/${a.id}/decision`, {
    requestId: randomUUID(),
    revision: 3,
    decision: "needs_fixes",
    note: "Исправить",
  });
  const nextId = randomUUID();
  assert.equal(
    (await request(f, "PUT", "/api/workspace/actions/" + nextId, { ...body, reviewRevision: 4 }))
      .status,
    200,
  );
  f.loseAck();
  await request(f, "POST", `/api/workspace/actions/${nextId}/submit`, { confirm: true });
  assert.equal((await request(f, "GET", `/api/workspace/actions/${nextId}`)).data.state, "unknown");
  assert.equal(
    (await request(f, "POST", `/api/workspace/actions/${nextId}/submit`, { confirm: true })).status,
    409,
  );
  assert.equal(f.calls.filter((c) => c.method === "turn/start").length, 2);
  assert.equal((await request(f, "GET", "/api/workspace/reviews")).data.items.length, 1);
});
test("terminal-before-final history creates a review only after its own final arrives and acceptance survives reload", async (t) => {
  const f = await handoffFixture();
  t.after(() => f.close());
  await f.release();
  const a = await run(f);
  f.finishTurn();
  assert.equal((await request(f, "GET", "/api/workspace/reviews")).data.items.length, 0);
  f.store.append(
    f.thread.id,
    "assistant.completed",
    { id: "unrelated", text: "Other work", phase: "final" },
    "other-turn",
  );
  assert.equal((await request(f, "GET", "/api/workspace/reviews")).data.items.length, 0);
  f.store.append(
    f.thread.id,
    "assistant.completed",
    { id: "late-final", text: "Точный ответ", phase: "final" },
    a.turnId,
  );
  assert.equal((await request(f, "GET", "/api/workspace/reviews")).data.items.length, 1);
  const input = { requestId: randomUUID(), revision: 1, decision: "accepted" };
  await request(f, "POST", `/api/workspace/reviews/${a.id}/decision`, input);
  const { WorkReviews } = await import("../apps/hub/dist/work-reviews.js");
  const reloaded = new WorkReviews(f.sessions, null);
  assert.equal(reloaded.get(a.id).state, "accepted");
  assert.equal(reloaded.get(a.id).answer, "Точный ответ");
});
