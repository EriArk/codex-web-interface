import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Notebook } from "../apps/hub/dist/notebook.js";
import { handoffFixture } from "./handoff-fixture.mjs";

const project = { client: "codex", projectId: "project", name: "Проект" };
const input = (scope = null) => ({
  revision: 0,
  scope,
  title: "Решения 100%",
  body: "Привет Мир_текст\n**важно**",
  links: [],
});
test("notes stay scoped, literal Unicode search and metadata pagination don't copy complete content", async (t) => {
  const f = await handoffFixture();
  t.after(() => f.close());
  const book = new Notebook(f.sessions);
  const global = book.save(randomUUID(), input()),
    local = book.save(randomUUID(), input(project));
  assert.equal(book.list("global", "100%", 0).items[0].id, global.id);
  assert.equal(book.list("codex:project", "ПРИВЕТ", 0).items[0].id, local.id);
  assert.equal(book.list("all", "Мир_", 0).items.length, 2);
  assert.equal(book.list("all", "NOT%", 0).items.length, 0);
  assert(!("body" in book.list("all", "", 0).items[0]));
  for (let i = 0; i < 35; i++)
    book.save(randomUUID(), { ...input(), title: `page ${i}`, body: "x".repeat(1000) });
  const page = book.list("all", "page", 0),
    older = book.list("all", "page", page.nextOffset);
  assert.equal(page.items.length, 30);
  assert.equal(page.nextOffset, 30);
  assert.equal(older.items.length, 5);
  assert.equal(older.nextOffset, null);
  assert(new Set([...page.items, ...older.items].map((n) => n.id)).size === 35);
  assert(page.items.every((n) => n.excerpt.length === 160));
});
test("lost save responses are idempotent; concurrent edits and delete/recreate require an explicit choice", async (t) => {
  const f = await handoffFixture();
  t.after(() => f.close());
  const book = new Notebook(f.sessions),
    id = randomUUID(),
    original = input();
  const a = book.save(id, original);
  assert.equal(a.revision, 1);
  assert.equal(book.save(id, original).revision, 1);
  const b = book.save(id, { ...original, revision: 1, body: "Другой планшет" });
  assert.equal(b.revision, 2);
  assert.throws(
    () => book.save(id, { ...original, revision: 1, body: "Мой iPhone" }),
    (e) => e.code === "NOTE_CONFLICT",
  );
  assert.throws(
    () => book.remove(id, 1),
    (e) => e.code === "NOTE_CONFLICT",
  );
  const c = book.save(id, { ...original, revision: 2, body: "Мой iPhone" });
  assert.equal(c.revision, 3);
  book.remove(id, 3);
  assert.throws(
    () => book.save(id, { ...original, revision: 3 }),
    (e) => e.code === "NOTE_DELETED",
  );
  assert.equal(book.save(randomUUID(), original).revision, 1);
});
test("pins and backlinks retain owner context after a source is renamed or removed; native GPT pins are not mutated", async (t) => {
  const f = await handoffFixture();
  t.after(() => f.close());
  const book = new Notebook(f.sessions),
    target = { client: "codex", kind: "thread", id: f.thread.id, title: "Old" };
  book.pin(project, target, true);
  book.pin(project, target, true);
  assert.equal(book.pins("all", 0).items.length, 1);
  assert.equal(book.pins("all", 0).items[0].target.title, "Handoff chat");
  book.pin(null, target, true);
  assert.equal(book.pins("all", 0).items.length, 2);
  const note = book.save(randomUUID(), { ...input(project), links: [target] });
  assert.equal(note.resolvedLinks[0].availability, "available");
  f.sessions.catalog.library.save("thread", f.thread.codexThreadId, { deleted: true });
  assert.equal(book.get(note.id).resolvedLinks[0].availability, "missing");
  assert.equal(book.get(note.id).body, input().body);
  const noteTarget = { client: "codex", kind: "note", id: note.id, title: note.title };
  book.pin(project, noteTarget, true);
  book.remove(note.id, note.revision);
  assert.equal(book.resolve(noteTarget).availability, "missing");
  assert(book.pinned(project, noteTarget));
  const gpt = {
    client: "gpt",
    kind: "thread",
    id: randomUUID(),
    threadId: randomUUID(),
    title: "GPT",
  };
  book.pin(null, gpt, true);
  assert.equal(book.resolve(gpt).availability, "unknown");
  assert.equal(
    f.store.db.prepare("SELECT count(*) AS n FROM library_entities WHERE client='gpt'").get().n,
    0,
  );
  assert.equal(f.calls.length, 0);
  assert.equal(f.desktopCalls.length, 0);
});
test("notebook routes require existing auth and CSRF, reject oversized or executable-shaped input, and preserve native writers", async (t) => {
  const f = await handoffFixture();
  t.after(() => f.close());
  const id = randomUUID(),
    url = `/api/workspace/notes/${id}`;
  assert.equal((await f.app.inject({ url: "/api/workspace/notes" })).statusCode, 401);
  assert.equal(
    (
      await f.app.inject({
        method: "PUT",
        url,
        headers: { cookie: f.headers.cookie },
        payload: input(),
      })
    ).statusCode,
    403,
  );
  for (const payload of [
    { ...input(), body: "x".repeat(65537) },
    { ...input(), command: "rm" },
    { ...input(), scope: { ...project, projectId: "../" } },
    { ...input(), links: [{ client: "codex", kind: "shell", id: "run", title: "x" }] },
  ])
    assert.equal(
      (await f.app.inject({ method: "PUT", url, headers: f.headers, payload })).statusCode,
      400,
    );
  assert.equal(
    (await f.app.inject({ method: "PUT", url, headers: f.headers, payload: input() })).statusCode,
    200,
  );
  assert.equal(
    (await f.app.inject({ method: "DELETE", url, headers: f.headers, payload: { revision: 1 } }))
      .statusCode,
    400,
  );
  assert.equal(
    (
      await f.app.inject({
        method: "DELETE",
        url,
        headers: f.headers,
        payload: { revision: 1, confirm: true },
      })
    ).statusCode,
    200,
  );
  assert.equal(f.calls.length, 0);
  assert.equal(f.desktopCalls.length, 0);
});

test("a removed Result leaves a readable note and a missing backlink, without a foreign-key cascade", async (t) => {
  const f = await handoffFixture();
  t.after(() => f.close());
  const book = new Notebook(f.sessions),
    id = randomUUID();
  f.store.db
    .prepare(
      "INSERT INTO results(id,threadId,turnId,sourceKey,type,title,payload,createdAt) VALUES(?,?,?,?,?,?,?,?)",
    )
    .run(id, f.thread.id, "turn", "source", "check", "Проверка", "{}", new Date().toISOString());
  const target = { client: "codex", kind: "result", id, title: "result" };
  const note = book.save(randomUUID(), { ...input(), links: [target] });
  assert.equal(note.resolvedLinks[0].threadId, f.thread.id);
  assert.equal(note.resolvedLinks[0].title, "Проверка");
  book.pin(null, target, true);
  f.store.db.prepare("DELETE FROM results WHERE id=?").run(id);
  assert.equal(book.get(note.id).resolvedLinks[0].availability, "missing");
  assert.equal(book.pins("global", 0).items[0].target.availability, "missing");
  assert.equal(book.get(note.id).body, input().body);
});

test("message capture preserves exact visible text and frozen source, retries without duplication or native writes", async (t) => {
  const f = await handoffFixture();
  t.after(() => f.close());
  const book = new Notebook(f.sessions),
    id = randomUUID();
  const capture = {
    scope: project,
    text: "Ответ\n```txt\n  exact  \n```",
    role: "assistant",
    target: {
      client: "codex",
      kind: "thread",
      id: f.thread.id,
      threadId: f.thread.id,
      messageId: "message-1",
      turnId: "turn-1",
      title: "Исходный ответ",
    },
  };
  const first = book.capture(id, capture);
  assert.equal(first.body, capture.text);
  assert.equal(first.source.text, capture.text);
  assert.equal(first.source.nativeThreadId, f.thread.codexThreadId);
  assert.equal(first.source.target.messageId, "message-1");
  assert.equal(book.capture(id, capture).revision, 1);
  assert.equal(book.capture(randomUUID(), capture).id, id);
  assert.equal(book.list("all", "", 0).items.length, 1);
  assert.equal(book.capture(randomUUID(), { ...capture, scope: null }).scope, null);
  book.save(id, { ...first, body: "Редакция владельца", revision: 1 });
  assert.equal(book.get(id).source.text, capture.text);
  assert.equal(book.get(id).body, "Редакция владельца");
  f.sessions.catalog.library.save("thread", f.thread.codexThreadId, { deleted: true });
  assert.equal(book.get(id).resolvedLinks[0].availability, "missing");
  assert.equal(book.get(id).source.text, capture.text);
  const gpt = book.capture(randomUUID(), {
    ...capture,
    target: { ...capture.target, client: "gpt", id: "gpt-thread" },
  });
  assert.equal(gpt.source.nativeThreadId, "gpt-thread");
  book.pin(null, capture.target, true);
  book.pin(null, { ...capture.target, messageId: "message-2" }, true);
  assert.equal(book.pins("global", 0).items.length, 2);
  assert.equal(f.calls.length, 0);
  assert.equal(f.desktopCalls.length, 0);
  book.remove(id, 2);
  assert.equal(book.source(id), undefined);
});

test("capture endpoint enforces password session, CSRF and a message source", async (t) => {
  const f = await handoffFixture();
  t.after(() => f.close());
  const url = "/api/workspace/notes/" + randomUUID() + "/capture",
    payload = {
      scope: null,
      text: "visible",
      role: "assistant",
      target: { client: "codex", kind: "thread", id: f.thread.id, title: "Ответ", messageId: "m1" },
    };
  assert.equal((await f.app.inject({ method: "PUT", url, payload })).statusCode, 401);
  assert.equal(
    (await f.app.inject({ method: "PUT", url, payload, headers: { cookie: f.headers.cookie } }))
      .statusCode,
    403,
  );
  assert.equal(
    (await f.app.inject({ method: "PUT", url, payload, headers: f.headers })).statusCode,
    200,
  );
  assert.equal(
    (
      await f.app.inject({
        method: "PUT",
        url,
        payload: { ...payload, target: { ...payload.target, messageId: undefined } },
        headers: f.headers,
      })
    ).statusCode,
    400,
  );
  assert.equal(f.calls.length, 0);
});
