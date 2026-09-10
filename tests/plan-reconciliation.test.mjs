import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { makeProposal } from "../apps/hub/dist/plan-reconciliation.js";
import { handoffFixture } from "./handoff-fixture.mjs";

const scope = { client: "codex", projectId: "project", name: "Project" };
const snapshot = () => ({
  id: randomUUID(),
  revision: 1,
  title: "План",
  sections: [
    {
      id: randomUUID(),
      title: "Работа",
      items: ["Уже есть", "Сервер", "Клиент", "Планшет", "Документация", "Релиз"].map(
        (text, i) => ({ id: randomUUID(), text, checked: !i }),
      ),
    },
  ],
});
const block = (p) => "Результат\n\n```codex-plan-result\n" + JSON.stringify(p) + "\n```";
test("only an exact bounded payload proposes state; recorded successful commands alone can support verified", () => {
  const p = snapshot(),
    items = p.sections[0].items;
  const payload = {
    planId: p.id,
    revision: 1,
    items: items.slice(1).map((i, n) => ({
      id: i.id,
      state: ["complete", "complete", "partial", "unknown", "not_done"][n],
      commands: n === 0 ? ["pnpm test"] : [],
    })),
  };
  const action = { id: randomUUID(), snapshot: { plan: p } },
    review = {
      answer: block(payload),
      evidence: [{ id: "check", command: "pnpm test", status: "passed" }],
    };
  const value = makeProposal(action, review);
  assert.deepEqual(
    value.items.map((i) => i.state),
    ["complete", "verified", "complete", "partial", "unknown", "not_done"],
  );
  assert.deepEqual(value.items[1].evidenceIds, ["check"]);
  assert.equal(makeProposal(action, { ...review, evidence: [] }).items[1].state, "complete"); // GPT has no native check ledger.
  assert.equal(
    makeProposal(action, {
      ...review,
      evidence: [{ ...review.evidence[0], commandTruncated: true }],
    }).items[1].state,
    "complete",
  );
  assert.equal(
    makeProposal(action, { ...review, evidence: [{ ...review.evidence[0], status: "failed" }] })
      .items[1].state,
    "unknown",
  );
  assert.equal(
    makeProposal(action, { ...review, answer: "Всё готово и проверено!" }).origin,
    "missing",
  );
  for (const invalid of [
    { ...payload, planId: randomUUID() },
    { ...payload, revision: 2 },
    { ...payload, items: [...payload.items, payload.items[0]] },
    { ...payload, items: [{ ...payload.items[0], id: randomUUID() }] },
    { ...payload, items: [{ ...payload.items[0], state: "verified" }] },
  ]) {
    const proposal = makeProposal(action, { ...review, answer: block(invalid) });
    assert.equal(proposal.origin, "invalid");
    assert(proposal.items.slice(1).every((i) => i.state === "unknown"));
  }
  assert.equal(
    makeProposal(action, { ...review, answer: block(payload) + "\n" + block(payload) }).origin,
    "invalid",
  );
});
async function request(f, method, url, payload, status = 200) {
  const r = await f.app.inject({ method, url, payload, headers: f.headers });
  assert.equal(r.statusCode, status, r.body);
  return r.json();
}
async function completed(f) {
  await f.release();
  const p = snapshot(),
    id = randomUUID(),
    items = p.sections[0].items,
    input = {
      scope,
      title: p.title,
      description: "",
      sections: p.sections,
      links: [],
      revision: 0,
    };
  await request(f, "PUT", `/api/workspace/plans/${p.id}`, input);
  await request(f, "PUT", `/api/workspace/actions/${id}`, {
    scope,
    kind: "plan",
    planId: p.id,
    planRevision: 1,
  });
  const sent = await request(f, "POST", `/api/workspace/actions/${id}/submit`, { confirm: true });
  const payload = {
    planId: p.id,
    revision: 1,
    items: items.slice(1).map((item, i) => ({
      id: item.id,
      state: i < 2 ? "complete" : "partial",
      commands: i ? [] : ["pnpm test"],
    })),
  };
  f.store.result(f.thread.id, sent.turnId, "checks", "check", "Проверка", {
    command: "pnpm test",
    exitCode: 0,
  });
  f.store.append(
    f.thread.id,
    "assistant.completed",
    { id: "final", phase: "final", text: block(payload) },
    sent.turnId,
  );
  f.finishTurn();
  await request(f, "GET", `/api/workspace/reviews/${id}`);
  const url = `/api/workspace/reviews/${id}/plan`;
  const accept = () =>
    request(f, "POST", `/api/workspace/reviews/${id}/decision`, {
      requestId: randomUUID(),
      revision: 1,
      decision: "accepted",
    });
  const apply = {
    requestId: randomUUID(),
    reviewRevision: 2,
    planRevision: 1,
    itemIds: [items[1].id],
  };
  return { p, id, input, items, url, accept, apply };
}
test("owner-selected reconciliation is one atomic Plan revision, preserves Tasks/Core and survives lost acknowledgement", async (t) => {
  const f = await handoffFixture();
  t.after(() => f.close());
  const a = await completed(f),
    read = () => request(f, "GET", `/api/workspace/plans/${a.p.id}`);
  await request(f, "GET", `/api/workspace/reviews/${a.id}`);
  await request(f, "POST", a.url, a.apply, 409);
  await a.accept();
  assert.equal((await read()).revision, 1); // Accept is not Apply.
  await request(f, "POST", a.url, { ...a.apply, itemIds: [a.items[3].id] }, 400);
  f.store.db.exec(
    "CREATE TRIGGER fail_reconciliation BEFORE INSERT ON work_review_receipts BEGIN SELECT RAISE(ABORT,'simulated receipt failure'); END;",
  );
  await request(f, "POST", a.url, a.apply, 500);
  assert.equal((await read()).revision, 1);
  assert.equal((await request(f, "GET", a.url)).proposal.applied, undefined);
  f.store.db.exec("DROP TRIGGER fail_reconciliation;");
  const applied = await request(f, "POST", a.url, a.apply);
  assert.equal(applied.proposal.applied.planRevision, 2);
  assert.deepEqual(await request(f, "POST", a.url, a.apply), applied);
  assert.equal((await read()).revision, 2);
  assert.deepEqual(
    (await read()).sections[0].items.map((i) => i.checked),
    [true, true, false, false, false, false],
  );
  await request(f, "POST", a.url, { ...a.apply, itemIds: [a.items[2].id] }, 409);
  await request(f, "POST", a.url, { ...a.apply, requestId: randomUUID() }, 409);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM workspace_tasks").get().n, 0);
  assert.equal(f.calls.filter((c) => c.method === "turn/start").length, 1);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM plan_reconciliations").get().n, 1);
});
test("stale/deleted Plan retains the proposal and cannot be overwritten or recreated", async (t) => {
  const f = await handoffFixture();
  t.after(() => f.close());
  const a = await completed(f);
  await a.accept();
  await request(f, "PUT", `/api/workspace/plans/${a.p.id}`, {
    ...a.input,
    revision: 1,
    title: "Изменённый план",
  });
  assert.equal((await request(f, "GET", a.url)).planState, "changed");
  await request(f, "POST", a.url, a.apply, 409);
  await request(f, "DELETE", `/api/workspace/plans/${a.p.id}`, { revision: 2, confirm: true });
  assert.equal((await request(f, "GET", a.url)).planState, "deleted");
  await request(f, "POST", a.url, a.apply, 409);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM project_plans").get().n, 0);
});
test("a correction keeps the executed Plan revision and large valid Plans still prepare", async (t) => {
  const f = await handoffFixture();
  t.after(() => f.close());
  const a = await completed(f);
  await request(f, "POST", `/api/workspace/reviews/${a.id}/decision`, {
    requestId: randomUUID(),
    revision: 1,
    decision: "needs_fixes",
    note: "Поправить мобильный вид",
  });
  const next = await request(f, "PUT", `/api/workspace/actions/${randomUUID()}`, {
    scope,
    kind: "correction",
    reviewId: a.id,
    reviewRevision: 2,
  });
  assert.equal(next.snapshot.plan.id, a.p.id);
  assert.equal(next.snapshot.plan.revision, 1);
  assert.match(next.text, /codex-plan-result/);
  const sections = Array.from({ length: 4 }, () => ({
    id: randomUUID(),
    title: "Шаги",
    items: Array.from({ length: 50 }, () => ({
      id: randomUUID(),
      text: "Проверить состояние",
      checked: false,
    })),
  }));
  const planId = randomUUID();
  await request(f, "PUT", `/api/workspace/plans/${planId}`, { ...a.input, sections });
  const large = await request(f, "PUT", `/api/workspace/actions/${randomUUID()}`, {
    scope,
    kind: "plan",
    planId,
    planRevision: 1,
  });
  assert(large.text.length < 32000);
  assert(large.text.includes(sections[3].items[49].id));
});
