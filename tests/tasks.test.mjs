import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { GptService } from "../apps/hub/dist/gpt.js";
import { Library } from "../apps/hub/dist/library.js";
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

test("global task project filters use saved Hub metadata, retain missing associations and remain paged without native calls", async (t) => {
  const f = await handoffFixture();
  t.after(() => f.close());
  const tasks = new WorkspaceTasks(f.sessions),
    library = new Library(f.store, "gpt");
  const gptScope = { client: "gpt", projectId: "g-example", name: "GPT Project" };
  const saved = tasks.save(randomUUID(), input({ scope: gptScope, body: "Keep owner text" }));
  library.save("project", gptScope.projectId, { name: "Renamed GPT", archived: true });
  tasks.save(randomUUID(), input({ scope: { client: "codex", projectId: "gone", name: "Gone" } }));
  const response = await f.app.inject({ url: "/api/workspace/tasks/projects", headers: f.headers });
  assert.equal(response.statusCode, 200);
  const items = response.json().items;
  assert.equal(items.find((p) => p.scope.projectId === "project").availability, "available");
  assert.equal(items.find((p) => p.scope.projectId === "gone").availability, "missing");
  assert.deepEqual(
    items.find((p) => p.scope.projectId === "g-example"),
    { scope: { ...gptScope, name: "Renamed GPT" }, availability: "archived" },
  );
  library.save("project", gptScope.projectId, { deleted: true });
  assert.equal(
    tasks.projects().items.find((p) => p.scope.projectId === "g-example").availability,
    "missing",
  );
  assert.equal(tasks.get(saved.id).body, "Keep owner text");
  for (let i = 0; i < 120; i++)
    library.save("project", `g-empty-${i}`, { name: `Empty ${String(i).padStart(3, "0")}` });
  const page = tasks.projects();
  assert.equal(page.items.length, 100);
  const next = tasks.projects(page.nextOffset);
  assert.equal(
    new Set([...page.items, ...next.items].map((p) => `${p.scope.client}:${p.scope.projectId}`))
      .size,
    123,
  );
  assert.equal(next.nextOffset, null);
  f.sessions.catalog.library.save("project", "project", { deleted: true });
  library.save("project", "g-deleted-empty", { name: "Deleted empty", deleted: true });
  assert(
    !tasks.projects().items.some((p) => ["project", "g-deleted-empty"].includes(p.scope.projectId)),
  );
  assert.equal(tasks.get(saved.id).body, "Keep owner text");
  assert.equal((await f.app.inject({ url: "/api/workspace/tasks/projects" })).statusCode, 401);
  assert.equal(
    (await f.app.inject({ url: "/api/workspace/tasks/projects?offset=-1", headers: f.headers }))
      .statusCode,
    400,
  );
  assert.equal(f.calls.length, 0);
  assert.equal(f.desktopCalls.length, 0);
});
test("normal GPT project discovery caches only public project names for offline Tasks, preserving local actions", async (t) => {
  const f = await handoffFixture();
  t.after(() => f.close());
  const library = new Library(f.store, "gpt"),
    calls = [];
  const service = {
    library,
    pins: async () => [],
    json: async (path) => {
      calls.push(path);
      return {
        items: [
          {
            gizmo: {
              gizmo: {
                id: "g-p-task-cache",
                display: { name: "Cached project" },
                instructions: "PRIVATE",
              },
            },
          },
        ],
      };
    },
  };
  await GptService.prototype.projects.call(service);
  const entry = library.get("project", "g-p-task-cache");
  assert.equal(entry.name, "Cached project");
  assert.doesNotMatch(JSON.stringify(entry), /PRIVATE|instructions/);
  let changes = 0;
  f.store.changes.on("navigation", () => changes++);
  await GptService.prototype.projects.call(service);
  assert.equal(changes, 0);
  library.save("project", entry.id, { archived: true });
  const tasks = new WorkspaceTasks(f.sessions);
  assert.equal(
    tasks.projects().items.find((p) => p.scope.projectId === entry.id).availability,
    "archived",
  );
  assert.deepEqual(calls, ["/projects", "/projects"]);
  assert.equal(f.calls.length, 0);
});
