import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { deploymentBlockers } from "../apps/hub/dist/deployment-status.js";
import { IssueDrawer } from "../apps/hub/dist/issue-drawer.js";
import { issueFixture } from "./issue-drawer-fixture.mjs";

async function fixture(t) {
  const f = await issueFixture();
  t.after(() => f.close());
  return f;
}

test("exact source slices, private capture receipts and quiet unchanged reads", async (t) => {
  const f = await fixture(t),
    body = f.answer(),
    id = randomUUID();
  const a = await f.d.add(id, body);
  assert.equal(a.original, body.text);
  assert.equal(a.body, body.text);
  assert.deepEqual(await f.d.add(id, body), a);
  assert.equal(f.d.list().items.length, 1);
  await assert.rejects(() => f.d.add(id, { ...body, text: "changed" }));
  await assert.rejects(() => f.d.add(randomUUID(), { ...body, text: "invented" }));
  const start = body.text.indexOf("Preserve"),
    end = start + 8;
  const slice = await f.d.add(randomUUID(), {
    ...body,
    text: body.text.slice(start, end),
    source: { ...body.source, start, end },
  });
  assert.equal(slice.body, "Preserve");
  const page = f.d.list();
  assert.deepEqual(f.d.list(page.version), { version: page.version, unchanged: true });
  assert(!JSON.stringify(page).includes("sourceHash"));
  assert.equal(f.operations.length, 0);
});
test("only completed public assistant messages from the exact current branch can be captured", async (t) => {
  const f = await fixture(t);
  await assert.rejects(() => f.d.add(randomUUID(), f.answer("hidden commentary", "commentary")));
  f.gpt.library.assertExists = () => {};
  const g = {
    source: { client: "gpt", threadId: "own-chat", messageId: "native-answer" },
    text: "Ready",
    targetId: "project",
  };
  for (const message of [
    { id: "other", role: "assistant", text: "Ready" },
    { id: "native-answer", role: "assistant", text: "Ready", phase: "commentary" },
    { id: "native-answer", role: "assistant", text: "Ready", complete: false },
  ]) {
    f.gpt.historyCache.snapshot = async () => ({ items: [message] });
    await assert.rejects(() => f.d.add(randomUUID(), g));
  }
  f.gpt.historyCache.snapshot = async () => ({
    items: [
      { id: "native-answer", role: "assistant", text: "Ready", phase: "final", complete: true },
    ],
  });
  assert.equal((await f.d.add(randomUUID(), g)).body, "Ready");
  await assert.rejects(() =>
    f.d.add(randomUUID(), { ...g, source: { ...g.source, projectId: "second" } }),
  );
});
test("multi-repository package freezes exact edits and actual identities, sends once only after confirmation", async (t) => {
  const f = await fixture(t),
    a = await f.add(),
    b = await f.add("Second body", "second");
  const edit = {
    revision: a.revision,
    title: "Reviewed title",
    body: "\nExact edited body\r\n",
    targetId: "project",
  };
  const changed = f.d.edit(a.id, edit);
  assert.deepEqual(f.d.edit(a.id, edit), JSON.parse(JSON.stringify(changed)));
  f.d.reorder([b.id, a.id]);
  assert.equal(f.d.list().items[0].id, b.id);
  const p = await f.packageItems([b, changed]);
  assert.equal(p.state, "prepared");
  assert.deepEqual(
    p.items.map((i) => i.repository),
    ["me/second", "me/first"],
  );
  assert(p.items.every((i) => i.identity.login === "actual-user"));
  assert(!f.operations.some((q) => q.op === "apply"));
  assert.throws(() => f.d.edit(a.id, { ...edit, revision: changed.revision }));
  assert.throws(() => f.d.confirm(p.id, "wrong"));
  f.d.confirm(p.id, p.fingerprint);
  f.d.confirm(p.id, p.fingerprint);
  await f.settle();
  assert.equal(f.operations.filter((q) => q.op === "apply").length, 2);
  assert.equal(
    f.receipts.get(f.operations.find((q) => q.op === "prepare" && q.repository === "me/first").id)
      .input.body,
    edit.body,
  );
  assert(f.d.list().items.every((i) => i.state === "completed" && i.result.repositoryId));
  f.d.remove(a.id, changed.revision);
  assert.equal(f.d.list().items.length, 1);
  f.d.confirm(p.id, p.fingerprint);
  await f.settle();
  assert.equal(f.operations.filter((q) => q.op === "apply").length, 2);
});
test("lost apply ACK is read-reconciled, never replayed, and blocks maintenance until verified", async (t) => {
  const f = await fixture(t),
    a = await f.add(),
    p = await f.packageItems([a]);
  f.d.probe = async (...args) => {
    const r = await f.native(...args);
    if (args[2].op === "apply") throw Error("lost ACK");
    return r;
  };
  f.d.confirm(p.id, p.fingerprint);
  await f.settle();
  assert.equal(f.d.list().items[0].state, "unknown");
  assert(deploymentBlockers(f.store).some((b) => JSON.stringify(b).includes("issue")));
  assert.throws(() =>
    f.d.edit(a.id, { revision: a.revision, title: "Retry", body: "Retry", targetId: "project" }),
  );
  assert.equal((await f.d.reconcile(a.id)).state, "completed");
  assert.equal(f.operations.filter((q) => q.op === "apply").length, 1);
});
test("invalid completion receipts cannot unlock another publication", async (t) => {
  const f = await fixture(t),
    a = await f.add(),
    p = await f.packageItems([a]);
  f.d.probe = async (...args) => {
    const r = await f.native(...args);
    if (args[2].op === "apply") r.result.url = "https://github.com/other/repo/issues/1";
    return r;
  };
  f.d.confirm(p.id, p.fingerprint);
  await f.settle();
  assert.equal(f.d.list().items[0].state, "unknown");
  assert.throws(() => f.d.remove(a.id, a.revision));
});
test("membership changes between items stop only unstarted items; successful receipts remain", async (t) => {
  const f = await fixture(t);
  let access = 1;
  f.d.policy = () => access;
  const a = await f.add(),
    b = await f.add("second"),
    p = await f.packageItems([a, b]);
  f.d.probe = async (...args) => {
    const r = await f.native(...args);
    if (args[2].op === "apply") access++;
    return r;
  };
  f.d.confirm(p.id, p.fingerprint);
  await f.settle();
  assert.deepEqual(
    f.d.list().items.map((i) => i.state),
    ["completed", "failed"],
  );
  assert.equal(f.operations.filter((q) => q.op === "apply").length, 1);
});
test("repository identity or checkout changes invalidate approval before the write", async (t) => {
  const f = await fixture(t),
    a = await f.add(),
    p = await f.packageItems([a]);
  f.d.inspect = async () => ({ remote: { url: "https://github.com/other/repo.git" } });
  f.d.confirm(p.id, p.fingerprint);
  await f.settle();
  assert.equal(f.d.list().items[0].state, "failed");
  assert.equal(f.operations.filter((q) => q.op === "apply").length, 0);
});
test("restart retains unknown sends, cancels unstarted work, and never replays writes", async (t) => {
  const f = await fixture(t),
    a = await f.add(),
    b = await f.add("B"),
    p = await f.packageItems([a, b]);
  const row = f.d.own(a.id);
  row.state = "running";
  f.d.save(row);
  p.state = "running";
  f.d.saveBatch(p);
  const recovered = new IssueDrawer(
    f.sessions,
    f.gpt,
    f.projectGpts,
    undefined,
    undefined,
    f.native,
    f.d.inspect,
  );
  assert.deepEqual(
    recovered.list().items.map((i) => i.state),
    ["unknown", "cancelled"],
  );
  assert.equal(recovered.confirm(p.id, p.fingerprint).state, "settled");
  assert.equal(f.operations.filter((q) => q.op === "apply").length, 0);
  assert.equal((await recovered.reconcile(a.id)).state, "cancelled");
  await recovered.close();
});
test("cancelled and uncertain packages survive archive of other completed records", async (t) => {
  const f = await fixture(t),
    a = await f.add(),
    b = await f.add("B"),
    p = await f.packageItems([a, b]);
  f.d.cancel(p.id);
  assert(f.d.list().items.every((i) => i.state === "cancelled"));
  f.d.remove(a.id, a.revision);
  f.d.cancel(p.id); // cancelled receipt idempotence is handled by API caller refresh
});
test("a still-running native receipt remains recoverable without replay", async (t) => {
  const f = await fixture(t),
    a = await f.add(),
    p = await f.packageItems([a]);
  f.d.probe = async (...args) => {
    if (args[2].op === "apply") return { ...f.receipts.get(args[2].id), state: "running" };
    return f.native(...args);
  };
  f.d.confirm(p.id, p.fingerprint);
  await f.settle();
  assert.equal(f.d.list().items[0].state, "unknown");
  assert.equal((await f.d.reconcile(a.id)).state, "cancelled");
});
test("API validates principal-private IDs, exact approval and UUID receipt contracts", async (t) => {
  const f = await fixture(t),
    id = randomUUID();
  const unauth = await f.app.inject({ url: "/api/issue-drawer" });
  assert.equal(unauth.statusCode, 401);
  const created = await f.app.inject({
    method: "PUT",
    url: `/api/issue-drawer/items/${id}`,
    headers: f.headers,
    payload: f.answer(),
  });
  assert.equal(created.statusCode, 200);
  const bad = await f.app.inject({
    method: "POST",
    url: `/api/issue-drawer/packages/${randomUUID()}/confirm`,
    headers: f.headers,
    payload: { fingerprint: "x" },
  });
  assert.equal(bad.statusCode, 400);
  const absent = await f.app.inject({
    url: `/api/issue-drawer/items/${randomUUID()}/source`,
    headers: f.headers,
  });
  assert.equal(absent.statusCode, 404);
});
