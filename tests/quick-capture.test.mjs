import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { handoffFixture } from "./handoff-fixture.mjs";

const scope = { client: "codex", projectId: "project", name: "Project" };
async function request(f, method, url, payload, status = 200) {
  const r = await f.app.inject({ method, url, payload, headers: f.headers });
  assert.equal(r.statusCode, status, r.body);
  return r.json();
}
test("Quick Capture writes normal Notes/Tasks once, keeps exact text and cannot duplicate or resurrect on lost acknowledgement", async (t) => {
  const f = await handoffFixture();
  t.after(() => f.close());
  const id = randomUUID(),
    url = `/api/workspace/captures/${id}`,
    text = "  Мысль про интерфейс\n\n  https://example.com/demo?key=public  ";
  const input = { kind: "note", scope, text };
  const first = await request(f, "PUT", url, input);
  assert.equal(first.kind, "note");
  assert.deepEqual(await request(f, "PUT", url, input), first);
  const note = await request(f, "GET", `/api/workspace/notes/${id}`);
  assert.equal(note.body, text);
  assert.equal(note.title, "Мысль про интерфейс");
  assert.equal(note.revision, 1);
  await request(f, "PUT", url, { ...input, kind: "task" }, 409);
  await request(f, "PUT", url, { ...input, text: "Changed" }, 409);
  await request(f, "DELETE", `/api/workspace/notes/${id}`, { revision: 1, confirm: true });
  assert.equal((await request(f, "PUT", url, input)).availability, "missing");
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM workspace_notes").get().n, 0);
  const taskId = randomUUID(),
    taskInput = {
      kind: "task",
      scope: null,
      text: "Проверить меню",
      priority: 2,
      dueAt: "2026-10-12",
    };
  await request(f, "PUT", `/api/workspace/captures/${taskId}`, taskInput);
  const task = await request(f, "GET", `/api/workspace/tasks/${taskId}`);
  assert.equal(task.scope, null);
  assert.equal(task.priority, 2);
  assert.equal(task.dueAt, "2026-10-12");
  assert.equal(task.status, "todo");
  assert.equal(f.calls.filter((c) => c.method === "turn/start").length, 0);
  assert.equal(f.desktopCalls.length, 0);
});
test("capture has the ordinary session/CSRF boundary, preserves GPT scope, and rolls back if its receipt cannot be saved", async (t) => {
  const f = await handoffFixture();
  t.after(() => f.close());
  const id = randomUUID(),
    url = `/api/workspace/captures/${id}`,
    input = {
      kind: "note",
      scope: { client: "gpt", projectId: "gpt-project", name: "GPT Project" },
      text: "Exact thought",
    };
  assert.equal((await f.app.inject({ method: "PUT", url, payload: input })).statusCode, 401);
  assert.equal(
    (
      await f.app.inject({
        method: "PUT",
        url,
        payload: input,
        headers: { cookie: f.headers.cookie, origin: f.headers.origin },
      })
    ).statusCode,
    403,
  );
  await request(f, "PUT", url, { ...input, text: " " }, 400);
  await request(f, "PUT", url, { ...input, text: "x".repeat(65537) }, 400);
  f.store.db.exec(
    "CREATE TRIGGER fail_capture BEFORE INSERT ON workspace_capture_receipts BEGIN SELECT RAISE(ABORT,'simulated failure'); END;",
  );
  await request(f, "PUT", url, input, 500);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM workspace_notes").get().n, 0);
  f.store.db.exec("DROP TRIGGER fail_capture;");
  const saved = await request(f, "PUT", url, input);
  assert.deepEqual(saved.scope, input.scope);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM workspace_capture_receipts").get().n, 1);
});
