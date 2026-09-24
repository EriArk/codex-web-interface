import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodexSchedules } from "../apps/hub/dist/codex-schedules.js";
import { GptService } from "../apps/hub/dist/gpt.js";
import { Library } from "../apps/hub/dist/library.js";
import { createSnapshot, restoreSnapshot, verifySnapshot } from "../apps/hub/dist/maintenance.js";
import { Notebook } from "../apps/hub/dist/notebook.js";
import { Previews } from "../apps/hub/dist/previews.js";
import { ProjectCores } from "../apps/hub/dist/project-core.js";
import { ProjectPlans } from "../apps/hub/dist/project-plans.js";
import { Store } from "../apps/hub/dist/store.js";
import { WorkspaceTasks } from "../apps/hub/dist/tasks.js";
import { configSchema } from "../packages/shared/dist/index.js";

function fixtureConfig(root) {
  return configSchema.parse({
    hub: {
      publicBaseUrl: "http://127.0.0.1:8981",
      secureCookies: false,
      databasePath: join(root, "app.db"),
      resultsPath: join(root, "results"),
    },
    auth: { username: "fixture" },
    machines: [],
    projects: [],
  });
}
test("workspace backup restores GPT bytes, saved HTML and pins without replaying old queued jobs", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-workspace-backup-")),
    config = fixtureConfig(root);
  const source = new Store(config.hub.databasePath),
    gpt = new GptService(config, source);
  let restored, restoredGpt;
  try {
    const bytes = Buffer.from("Uploaded UTF-8: пример"),
      upload = await gpt.put("example.txt", bytes);
    const thread = source.createThread("p", "native-id", "History");
    new Library(source, "codex").save("thread", thread.id, { name: "History", pinned: true });
    const book = new Notebook({
      store: source,
      catalog: { projects: () => [], library: new Library(source, "codex") },
    });
    const tasks = new WorkspaceTasks(book.sessions),
      task = tasks.save(randomUUID(), {
        scope: null,
        title: "Next step",
        body: "Keep owner-authored task",
        links: [],
        revision: 0,
        status: "blocked",
        priority: 2,
        dueAt: "2026-09-09",
      });
    const note = book.save(randomUUID(), {
      scope: null,
      title: "Keep project context",
      body: "Owner note **Markdown**",
      links: [{ client: "codex", kind: "thread", id: thread.id, title: thread.title }],
      revision: 0,
    });
    book.pin(null, { client: "codex", kind: "note", id: note.id, title: note.title }, true);
    const projectScope = { client: "codex", projectId: "p", name: "Project" },
      coreStore = new ProjectCores(book.sessions),
      baseCore = coreStore.get(projectScope);
    const core = coreStore.save({
      ...baseCore,
      value: { ...baseCore.value, rules: "Сохранять данные" },
    });
    const planStore = new ProjectPlans(book.sessions),
      plan = planStore.save(randomUUID(), {
        scope: projectScope,
        title: "План",
        description: "Работа",
        sections: [
          {
            id: randomUUID(),
            title: "Проверка",
            items: [{ id: randomUUID(), text: "Вернуть из копии", checked: false }],
          },
        ],
        links: [],
        revision: 0,
        status: "draft",
      });
    const captured = book.capture(randomUUID(), {
      scope: projectScope,
      role: "assistant",
      text: "Полезный ответ",
      target: {
        client: "codex",
        kind: "thread",
        id: thread.id,
        threadId: thread.id,
        messageId: "kept-message",
        title: "Источник",
      },
    });
    const actionId = randomUUID(),
      action = {
        id: actionId,
        scope: projectScope,
        kind: "plan",
        planId: plan.id,
        planRevision: 1,
        title: plan.title,
        text: "Не повторять после восстановления",
        state: "queued",
        threadId: thread.id,
        createdAt: 1,
        updatedAt: 1,
        snapshot: { plan: plan.id },
      };
    source.db
      .prepare("INSERT INTO project_work_actions VALUES(?,?,?,?,?,?,?,?,?)")
      .run(
        actionId,
        "codex:p",
        "plan",
        plan.id,
        "queued",
        "backup-fixture",
        JSON.stringify(action),
        1,
        1,
      );
    source.db
      .prepare("INSERT INTO project_reports VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .run(
        "report-backup",
        "codex:p",
        JSON.stringify(projectScope),
        "Итог",
        "Проверено. Не закончено: синхронизация.",
        "report-action",
        JSON.stringify({ client: "codex", kind: "thread", id: thread.id, title: thread.title }),
        1,
        2,
        JSON.stringify({ eventSeq: 7 }),
        3,
      );
    source.db
      .prepare("INSERT INTO project_current_chats VALUES(?,?,?,?,?)")
      .run("codex:p", JSON.stringify(projectScope), thread.id, 2, 3);
    source.db
      .prepare("INSERT INTO project_chat_history VALUES(?,?,?,?)")
      .run("codex:p", "old-thread", "Прежний", 2);
    const path = join(root, "design.html"),
      original = "<button>Original interactive design</button>";
    await writeFile(path, original);
    const previews = new Previews(join(config.hub.resultsPath, "previews"), source, () => ({
      machine: { type: "local-linux" },
      root,
    }));
    previews.observe(thread, null, {
      id: "saved",
      type: "fileChange",
      changes: [{ path, kind: { type: "add" } }],
    });
    const cached = source.db.prepare("SELECT id FROM html_previews").get().id;
    await previews.document(cached);
    previews.observe(thread, null, {
      id: "unopened",
      type: "fileChange",
      changes: [{ path: join(root, "unopened.html"), kind: { type: "add" } }],
    });
    const states = [
      "queued",
      "preparing",
      "running",
      "unknown",
      "completed",
      "cancelled",
      "failed",
    ];
    for (const status of states) {
      source.db
        .prepare(
          "INSERT INTO gpt_jobs(id,fingerprint,nativeId,text,files,model,effort,status,answer,assets,createdAt,updatedAt,error,submitted) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          randomUUID(),
          "fixture-" + status,
          "native-" + status,
          "Keep this request",
          JSON.stringify([upload.id]),
          "fixture",
          "0",
          status,
          "Saved answer",
          "[]",
          1,
          1,
          "",
          Number(status === "running"),
        );
    }
    const completedJob = source.db
      .prepare("SELECT id FROM gpt_jobs WHERE status='completed'")
      .get().id;
    source.db
      .prepare("INSERT INTO gpt_project_jobs VALUES(?,?,?,?)")
      .run(completedJob, "g-p-backup-project", 1, 2);
    // Neither unreferenced files nor a browser profile placed beside uploads are sweep targets.
    await mkdir(join(config.hub.resultsPath, "gpt", "profile"), { mode: 0o700 });
    await writeFile(
      join(config.hub.resultsPath, "gpt", "profile", "fixture-secret"),
      "not an upload",
    );
    source.db.prepare("INSERT INTO usage_reset_accounts VALUES('private-account-binding',7)").run();
    source.db
      .prepare("INSERT INTO usage_reset_operations VALUES(?,?,?,?,?,'pending',NULL,1,1)")
      .run(
        "retained-reset-key",
        "pc",
        "private-account-binding",
        "request-fingerprint",
        "opaque-credit",
      );
    const schedules = new CodexSchedules(
      source.db,
      {
        resolve() {
          return { threadId: thread.id, nativeId: "native-id", revision: 1 };
        },
        async send() {
          throw Error("must not send");
        },
      },
      () => Date.parse("2026-09-24T10:00Z"),
    );
    const scheduled = schedules.create(
      randomUUID(),
      {
        key: "binding",
        role: "work",
        name: "P",
        revision: 1,
        projectId: "p",
        stamp: "binding-stamp",
      },
      {
        text: "Do not replay after backup restore",
        rule: { date: "2026-09-25", time: "10:00", timezone: "UTC", weekdays: [] },
      },
    );
    const snapshot = await createSnapshot(config, join(root, "backups"));
    const manifest = await verifySnapshot(snapshot);
    assert.equal(manifest.format, 2);
    assert.deepEqual(manifest.cachedPreviews, [cached]);
    assert(manifest.files.some((f) => f.path === "results/gpt/" + upload.id));
    assert(manifest.files.some((f) => f.path === "results/previews/" + cached + ".html"));
    assert(!manifest.files.some((f) => f.path.includes("profile") || f.path.includes("unopened")));
    // Restored preview must use captured bytes even when the original machine is unavailable.
    await writeFile(path, "Changed after snapshot");
    const target = join(root, "restore");
    await restoreSnapshot(snapshot, target);
    restored = new Store(join(target, "app.db"));
    const restoredSchedule = JSON.parse(
      restored.db.prepare("SELECT value FROM codex_schedules WHERE id=?").get(scheduled.id).value,
    );
    assert.equal(restoredSchedule.state, "paused");
    assert.equal(restoredSchedule.nextAt, null);
    assert.equal(restoredSchedule.revision, scheduled.revision + 1);
    const reset = restored.db.prepare("SELECT * FROM usage_reset_operations").get();
    assert.equal(reset.id, "retained-reset-key");
    assert.equal(reset.creditId, "opaque-credit");
    assert.equal(reset.state, "unknown");
    assert.equal(
      restored.db.prepare("SELECT revision FROM usage_reset_accounts").get().revision,
      7,
    );
    const restoredBook = new Notebook({
      store: restored,
      catalog: { projects: () => [], library: new Library(restored, "codex") },
    });
    assert.deepEqual(restoredBook.get(note.id), note);
    assert.deepEqual(restoredBook.get(captured.id), captured);
    assert.deepEqual(new ProjectCores(restoredBook.sessions).get(projectScope), core);
    assert.equal(
      new ProjectPlans(restoredBook.sessions).get(plan.id).sections[0].items[0].text,
      "Вернуть из копии",
    );
    const restoredAction = restored.db
      .prepare("SELECT state,value FROM project_work_actions WHERE id=?")
      .get(actionId);
    assert.equal(restoredAction.state, "unknown");
    assert.equal(JSON.parse(restoredAction.value).state, "unknown");
    assert.equal(JSON.parse(restoredAction.value).text, action.text);
    assert.equal(
      restored.db.prepare("SELECT body FROM project_reports").get().body,
      "Проверено. Не закончено: синхронизация.",
    );
    assert.equal(
      restored.db.prepare("SELECT threadId FROM project_current_chats").get().threadId,
      thread.id,
    );
    assert.equal(
      restored.db.prepare("SELECT threadId FROM project_chat_history").get().threadId,
      "old-thread",
    );
    assert.equal(restored.db.prepare("SELECT verified FROM gpt_project_jobs").get().verified, 1);

    assert.deepEqual(new WorkspaceTasks(restoredBook.sessions).get(task.id), task);
    assert.equal(restoredBook.pins("global", 0).items[0].target.id, note.id);
    assert.equal(restoredBook.pins("global", 0).items[0].target.availability, "available");
    restoredGpt = new GptService(
      {
        ...config,
        hub: {
          ...config.hub,
          databasePath: join(target, "app.db"),
          resultsPath: join(target, "results"),
        },
      },
      restored,
    );
    assert.deepEqual(await readFile(join(target, "results", "gpt", upload.id)), bytes);
    assert.equal(restoredGpt.upload(upload.id).name, "example.txt");
    const restoredPreview = new Previews(join(target, "results", "previews"), restored, () => {
      throw Error("Machine unavailable");
    });
    assert((await restoredPreview.document(cached)).includes(original));
    assert.equal(restored.db.prepare("SELECT COUNT(*) AS n FROM html_previews").get().n, 2);
    assert.equal(new Library(restored, "codex").get("thread", thread.id).pinned, true);
    const actual = restored.db
      .prepare("SELECT nativeId,status,text,files,submitted FROM gpt_jobs ORDER BY nativeId")
      .all();
    for (const row of actual) {
      const status = row.nativeId.slice("native-".length);
      assert.equal(
        row.status,
        ["queued", "preparing", "running"].includes(status) ? "unknown" : status,
      );
      assert.equal(row.text, "Keep this request");
      assert.deepEqual(JSON.parse(row.files), [upload.id]);
      assert.equal(row.submitted, Number(status === "running"));
    }
    assert.deepEqual(
      source.db
        .prepare("SELECT status FROM gpt_jobs")
        .all()
        .map((r) => r.status),
      states,
    );
  } finally {
    await restoredGpt?.close();
    restored?.close();
    await gpt.close();
    source.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("backup verification rejects missing GPT bytes and captured HTML even if removed from file list", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-backup-coverage-")),
    config = fixtureConfig(root);
  const store = new Store(config.hub.databasePath),
    gpt = new GptService(config, store);
  try {
    const upload = await gpt.put("test.txt", Buffer.from("keep"));
    const t = store.createThread("p", "native", "Preview"),
      previews = new Previews(join(config.hub.resultsPath, "previews"), store, () => ({
        machine: { type: "local-linux" },
        root,
      }));
    previews.observe(t, null, {
      id: "p",
      type: "mcpToolCall",
      result: {
        content: [
          { type: "resource", resource: { mimeType: "text/html", text: "<button>Go</button>" } },
        ],
      },
    });
    const id = store.db.prepare("SELECT id FROM html_previews").get().id;
    await previews.document(id);
    for (const missing of ["results/gpt/" + upload.id, "results/previews/" + id + ".html"]) {
      const snapshot = await createSnapshot(config, join(root, "backups"));
      const manifest = JSON.parse(await readFile(join(snapshot, "manifest.json"), "utf8"));
      await rm(join(snapshot, missing));
      manifest.files = manifest.files.filter((f) => f.path !== missing);
      await writeFile(join(snapshot, "manifest.json"), JSON.stringify(manifest));
      await assert.rejects(verifySnapshot(snapshot), { code: "SNAPSHOT_INCOMPLETE" });
      await assert.rejects(restoreSnapshot(snapshot, join(root, "cannot-restore")), {
        code: "SNAPSHOT_INCOMPLETE",
      });
    }
    await rm(join(config.hub.resultsPath, "gpt", upload.id));
    const target = join(root, "missing-upload");
    await assert.rejects(createSnapshot(config, target));
    assert.deepEqual(await readdir(target), []);
  } finally {
    await gpt.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy backups remain readable and GPT/preview paths never follow symlinks outside storage", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-backup-legacy-")),
    config = fixtureConfig(root);
  const store = new Store(config.hub.databasePath),
    gpt = new GptService(config, store);
  try {
    const old = await createSnapshot(config, join(root, "legacy"));
    const manifest = JSON.parse(await readFile(join(old, "manifest.json"), "utf8"));
    manifest.format = 1;
    delete manifest.cachedPreviews;
    await writeFile(join(old, "manifest.json"), JSON.stringify(manifest));
    assert.equal((await verifySnapshot(old)).format, 1);
    await restoreSnapshot(old, join(root, "restored-legacy"));
    const upload = await gpt.put("link.txt", Buffer.from("safe"));
    await rm(join(config.hub.resultsPath, "gpt", upload.id));
    const outside = join(root, "outside");
    await writeFile(outside, "not an upload");
    await symlink(outside, join(config.hub.resultsPath, "gpt", upload.id));
    await assert.rejects(createSnapshot(config, join(root, "unsafe")), { code: "UNSAFE_FILE" });
    assert.equal(await readFile(outside, "utf8"), "not an upload");
  } finally {
    await gpt.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
