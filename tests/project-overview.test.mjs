import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { ProjectHome } from "../apps/hub/dist/overview.js";
import { handoffFixture } from "./handoff-fixture.mjs";

const scope = { client: "codex", projectId: "project", name: "Project" };
test("project overview composes bounded real modules, preserves unread state and never acquires a writer", async (t) => {
  const f = await handoffFixture();
  t.after(() => f.close());
  const home = new ProjectHome(f.sessions),
    db = f.store.db;
  db.prepare("UPDATE threads SET status='running',completedSeq=10,seenSeq=0 WHERE id=?").run(
    f.thread.id,
  );
  const unread = f.store.createThread("project", "native-unread", "Unread result");
  db.prepare("UPDATE threads SET completedSeq=8,seenSeq=1 WHERE id=?").run(unread.id);
  const removed = f.store.createThread("project", "native-removed", "Hidden removed chat");
  f.sessions.catalog.library.save("thread", removed.codexThreadId, { deleted: true });
  for (let i = 0; i < 10; i++) {
    const note = home.notes.save(randomUUID(), {
      scope,
      title: `Note ${i}`,
      body: "Owner text ".repeat(100),
      links: [],
      revision: 0,
    });
    home.notes.pin(scope, { client: "codex", kind: "note", id: note.id, title: note.title }, true);
    home.tasks.save(randomUUID(), {
      scope,
      title: `Task ${i}`,
      body: "Do not copy this into Home ".repeat(100),
      links: [],
      revision: 0,
      status: i === 0 ? "doing" : "todo",
      priority: 1,
      dueAt: null,
    });
    f.store.result(f.thread.id, null, `result-${i}`, "check", `Check ${i}`, {
      text: "Large technical output ".repeat(2000),
    });
  }
  f.store.result(removed.id, null, "hidden-result", "check", "Removed source", {});
  const before = db.prepare("SELECT id,seenSeq,completedSeq,status FROM threads ORDER BY id").all();
  for (let i = 0; i < 10; i++) {
    const page = home.get("codex", "project");
    assert.equal(page.threads[0].id, f.thread.id);
    assert.equal(page.threads[1].id, unread.id);
    assert.deepEqual(page.activity, { active: 1, unread: 1 });
    assert.equal(page.notes.length, 3);
    assert.equal(page.tasks.length, 4);
    assert.equal(page.pins.length, 3);
    assert.equal(page.results.length, 4);
    assert(page.results.every((r) => r.title !== "Removed source"));
    assert(JSON.stringify(page).length < 8000);
    assert(!JSON.stringify(page).includes("Large technical output"));
  }
  assert.deepEqual(
    db.prepare("SELECT id,seenSeq,completedSeq,status FROM threads ORDER BY id").all(),
    before,
  );
  assert.equal(f.calls.length, 0);
  assert.equal(f.desktopCalls.length, 0);
});
test("empty projects and stale machine/Git summaries remain honest without running probes", async (t) => {
  const f = await handoffFixture();
  t.after(() => f.close());
  f.sessions.config.projects.push({
    id: "empty",
    name: "Empty",
    machineId: "pc",
    workingDirectory: "C:/Empty",
    enabled: true,
  });
  const home = new ProjectHome(f.sessions),
    page = home.get("codex", "empty");
  assert.deepEqual(page.threads, []);
  assert.deepEqual(page.results, []);
  assert.equal(page.machine.stale, true);
  assert.equal(page.machine.online, undefined);
  assert.equal(page.git, undefined);
  const checkedAt = Date.now() - 120000;
  f.store.setPreferences({
    machineHealth: {
      pc: {
        probe: {
          checkedAt,
          online: false,
          checks: [{ layer: "protocol", state: "error", code: "CODEX_PROTOCOL_UNAVAILABLE" }],
        },
        lastSeenAt: checkedAt - 60000,
      },
    },
    projectGit: {
      empty: {
        checkedAt,
        root: "C:/Empty",
        repository: true,
        branch: "main",
        dirty: true,
        changed: 3,
      },
    },
  });
  const stale = home.get("codex", "empty");
  assert(stale.machine.stale);
  assert.equal(stale.machine.online, false);
  assert(stale.git.stale);
  assert.equal(stale.git.changed, 3);
  f.sessions.config.projects.find((p) => p.id === "empty").workingDirectory = "C:/Other";
  assert.equal(home.get("codex", "empty").git, undefined);
  assert.equal(f.calls.length, 0);
});
test("Home thumbnails use already stored Hub images only; native machine and signed remote assets are not fetched", async (t) => {
  const f = await handoffFixture();
  t.after(() => f.close());
  const home = new ProjectHome(f.sessions),
    id = randomUUID();
  f.store.db
    .prepare("INSERT INTO artifacts(id,threadId,mime,bytes,createdAt) VALUES(?,?,?,?,?)")
    .run(id, f.thread.id, "image/png", 100, new Date().toISOString());
  for (const [source, url] of [
    ["hub", `/api/artifacts/${id}`],
    ["native", "/api/native-images/some-file"],
    ["external", "https://private-signed.example/image?token=secret"],
  ])
    f.store.result(f.thread.id, null, source, "image", source, { url });
  const results = home.get("codex", "project").results;
  assert.equal(results.find((r) => r.title === "hub").imageUrl, `/api/artifacts/${id}`);
  assert.equal(results.find((r) => r.title === "native").imageUrl, undefined);
  assert(!JSON.stringify(results).includes("private-signed"));
});
test("authenticated GPT project context uses existing Hub notes/tasks and doesn't call the consumer connector", async (t) => {
  const f = await handoffFixture();
  t.after(() => f.close());
  const home = new ProjectHome(f.sessions),
    scope = { client: "gpt", projectId: "g-project", name: "GPT project" };
  home.notes.save(randomUUID(), {
    scope,
    title: "GPT note",
    body: "Context",
    links: [],
    revision: 0,
  });
  home.tasks.save(randomUUID(), {
    scope,
    title: "GPT task",
    body: "Follow-up",
    links: [],
    revision: 0,
    status: "todo",
    priority: 1,
    dueAt: null,
  });
  const url = "/api/workspace/overview?client=gpt&projectId=g-project";
  assert.equal((await f.app.inject({ url })).statusCode, 401);
  const response = await f.app.inject({ url, headers: f.headers });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().notes[0].title, "GPT note");
  assert.equal(response.json().tasks[0].title, "GPT task");
  assert.equal(response.json().machine, undefined);
  assert.equal(response.json().git, undefined);
  assert.equal(
    (
      await f.app.inject({
        url: "/api/workspace/overview?client=codex&projectId=missing",
        headers: f.headers,
      })
    ).statusCode,
    404,
  );
  assert.equal(f.calls.length, 0);
  assert.equal(f.desktopCalls.length, 0);
});
