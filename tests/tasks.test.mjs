import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { WorkspaceTasks } from "../apps/hub/dist/tasks.js";
import { taskWriteSchema } from "../packages/shared/dist/index.js";
import { handoffFixture } from "./handoff-fixture.mjs";

const scope = { client: "codex", projectId: "project", name: "Project" };
const input = (extra = {}) => ({
  title: "Продолжить работу",
  body: "Следующий шаг",
  scope: null,
  links: [],
  revision: 0,
  status: "todo",
  priority: 1,
  dueAt: null,
  ...extra,
});
test("tasks use scoped open/doing/blocked/completed views, priority, local dates and metadata-only paging", async (t) => {
  const f = await handoffFixture();
  t.after(() => f.close());
  const tasks = new WorkspaceTasks(f.sessions);
  const global = tasks.save(randomUUID(), input()),
    project = tasks.save(
      randomUUID(),
      input({ scope, status: "doing", priority: 2, dueAt: "2026-09-08" }),
    );
  tasks.save(randomUUID(), input({ scope, status: "blocked", dueAt: "2026-09-07" }));
  tasks.save(randomUUID(), input({ scope, status: "done", dueAt: "2026-09-08" }));
  assert.equal(tasks.list("global", "open", "", 0, "").items[0].id, global.id);
  assert.equal(tasks.list("codex:project", "open", "", 0, "").items[0].id, project.id);
  assert.equal(tasks.list("codex:project", "today", "", 0, "2026-09-08").items.length, 2);
  assert.equal(tasks.list("codex:project", "doing", "", 0, "").items.length, 1);
  assert.equal(tasks.list("all", "done", "", 0, "").items.length, 1);
  assert(!("body" in tasks.list("all", "open", "", 0, "").items[0]));
  for (let i = 0; i < 35; i++) tasks.save(randomUUID(), input({ title: `Уникальный 100% ${i}` }));
  const page = tasks.list("all", "all", "УНИКАЛЬНЫЙ 100%", 0, "");
  assert.equal(page.items.length, 30);
  assert.equal(tasks.list("all", "all", "Уникальный 100%", page.nextOffset, "").items.length, 5);
  assert.equal(tasks.list("all", "all", "_NO_MATCH", 0, "").items.length, 0);
});
test("status transitions are revisioned, completion timestamps remain stable, reopening preserves task content", async (t) => {
  const f = await handoffFixture();
  t.after(() => f.close());
  const tasks = new WorkspaceTasks(f.sessions),
    a = tasks.save(randomUUID(), input());
  const b = tasks.status(a.id, "doing", a.revision);
  assert.equal(b.revision, 2);
  assert.equal(b.completedAt, null);
  assert.throws(
    () => tasks.status(a.id, "blocked", 1),
    (e) => e.code === "TASK_CONFLICT",
  );
  const c = tasks.status(a.id, "done", 2);
  assert(c.completedAt);
  assert.equal(tasks.status(a.id, "done", 2).completedAt, c.completedAt);
  assert.equal(tasks.status(a.id, "done", 2).revision, 3);
  const d = tasks.status(a.id, "todo", 3);
  assert.equal(d.completedAt, null);
  assert.equal(d.body, a.body);
  const edited = tasks.save(a.id, { ...d, title: "Изменено" });
  assert.throws(
    () => tasks.save(a.id, { ...d, body: "Старый" }),
    (e) => e.code === "TASK_CONFLICT",
  );
  assert.throws(
    () => tasks.remove(a.id, d.revision),
    (e) => e.code === "TASK_CONFLICT",
  );
  tasks.remove(a.id, edited.revision);
  assert.throws(
    () => tasks.save(a.id, edited),
    (e) => e.code === "TASK_DELETED",
  );
});
test("task references and generic pins survive deleted projects, threads or tasks without cascading owner text", async (t) => {
  const f = await handoffFixture();
  t.after(() => f.close());
  const tasks = new WorkspaceTasks(f.sessions),
    target = { client: "codex", kind: "thread", id: f.thread.id, title: "thread" },
    a = tasks.save(randomUUID(), input({ scope, links: [target] }));
  assert.equal(a.resolvedLinks[0].threadId, f.thread.id);
  tasks.notebook.pin(scope, { client: "codex", kind: "task", id: a.id, title: a.title }, true);
  f.sessions.catalog.library.save("project", "project", { deleted: true });
  f.sessions.catalog.library.save("thread", f.thread.codexThreadId, { deleted: true });
  assert.equal(tasks.get(a.id).resolvedLinks[0].availability, "missing");
  assert.equal(tasks.get(a.id).body, a.body);
  tasks.remove(a.id, a.revision);
  assert.equal(tasks.notebook.pins("all", 0).items[0].target.availability, "missing");
  assert.equal(f.calls.length, 0);
});
test("task mutation dates/priority/fields are bounded and remain behind existing auth and CSRF", async (t) => {
  const f = await handoffFixture();
  t.after(() => f.close());
  const id = randomUUID(),
    url = `/api/workspace/tasks/${id}`;
  assert.equal((await f.app.inject({ url: "/api/workspace/tasks" })).statusCode, 401);
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
  for (const extra of [
    { dueAt: "2026-02-30" },
    { dueAt: "2026-09-08T12:00:00Z" },
    { priority: 3 },
    { status: "cancel" },
    { command: "native/send" },
  ])
    assert.equal(
      (await f.app.inject({ method: "PUT", url, headers: f.headers, payload: input(extra) }))
        .statusCode,
      400,
    );
  assert(taskWriteSchema.safeParse(input({ dueAt: "2028-02-29" })).success);
  assert.equal(
    (await f.app.inject({ method: "PUT", url, headers: f.headers, payload: input() })).statusCode,
    200,
  );
  assert.equal(
    (
      await f.app.inject({
        method: "PATCH",
        url: url + "/status",
        headers: f.headers,
        payload: { revision: 1, status: "done" },
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (await f.app.inject({ method: "DELETE", url, headers: f.headers, payload: { revision: 2 } }))
      .statusCode,
    400,
  );
  assert.equal(
    (await f.app.inject({ url: "/api/workspace/tasks?filter=today", headers: f.headers }))
      .statusCode,
    400,
  );
  assert.equal(f.calls.length, 0);
  assert.equal(f.desktopCalls.length, 0);
});
