import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ExternalActivity } from "../apps/hub/dist/externalActivity.js";
import { Store } from "../apps/hub/dist/store.js";
import { activityReader } from "../packages/machines/dist/activity.js";

test("external observation detects active and unread work; initial history is read and stale records are unknown", async () => {
  const store = new Store(":memory:"),
    events = [];
  const activity = new ExternalActivity(
    { machines: [] },
    store,
    { invalidate() {} },
    async () => "",
    async () => false,
    (e) => events.push(e),
  );
  try {
    const t = store.createThread("p", "native", "Desktop");
    const row = {
      threadId: "native",
      turnId: "old",
      status: "completed",
      startedAt: 1,
      completedAt: 2,
      updatedAt: 2,
    };
    activity.apply(t.id, row);
    assert.equal(store.navigation(["p"]).projects[0].unread, 0);
    const now = Math.floor(Date.now() / 1000);
    activity.apply(t.id, {
      ...row,
      turnId: "live",
      status: "inProgress",
      startedAt: now,
      updatedAt: now,
      completedAt: 0,
    });
    assert.equal(store.navigation(["p"]).projects[0].active, 1);
    assert.equal(store.thread(t.id).activitySource, "external");
    const start = store.thread(t.id).activityAt;
    activity.apply(t.id, {
      ...row,
      turnId: "live",
      status: "inProgress",
      startedAt: now,
      updatedAt: now + 1,
    });
    assert.equal(store.thread(t.id).activityAt, start);
    assert(events.filter((e) => e.type === "source.changed").length >= 3);
    activity.apply(t.id, {
      ...row,
      turnId: "live",
      startedAt: now,
      updatedAt: now + 2,
      completedAt: now + 2,
    });
    assert.equal(store.navigation(["p"]).projects[0].active, 0);
    assert.equal(store.navigation(["p"]).projects[0].unread, 1);
    const cursor = store.thread(t.id).completedSeq;
    activity.apply(t.id, {
      ...row,
      turnId: "live",
      startedAt: now,
      updatedAt: now + 2,
      completedAt: now + 2,
    });
    assert.equal(store.thread(t.id).completedSeq, cursor);
    activity.apply(t.id, {
      ...row,
      turnId: "stale",
      status: "inProgress",
      startedAt: 1,
      updatedAt: 2,
    });
    assert.equal(store.thread(t.id).status, "unknown");
  } finally {
    await activity.close();
    store.close();
  }
});
test("fixed native reader reads only latest status, excludes archived records and never changes native databases", () => {
  const home = mkdtempSync(join(tmpdir(), "native-activity-"));
  try {
    const state = new DatabaseSync(join(home, "state_5.sqlite"));
    state.exec(
      "CREATE TABLE threads(id TEXT PRIMARY KEY,updated_at INTEGER,archived INTEGER); INSERT INTO threads VALUES('a',3,0),('b',4,1);",
    );
    state.close();
    const history = new DatabaseSync(join(home, "thread_history_1.sqlite"));
    history.exec(
      "CREATE TABLE thread_turns(thread_id TEXT,turn_id TEXT,status TEXT,started_at INTEGER,completed_at INTEGER,rollout_ordinal INTEGER); INSERT INTO thread_turns VALUES('a','old','completed',1,2,1),('a','live','inProgress',3,NULL,2),('b','hidden','completed',1,2,1);",
    );
    history.close();
    const hash = () =>
      ["state_5.sqlite", "thread_history_1.sqlite"].map((f) =>
        createHash("sha256")
          .update(readFileSync(join(home, f)))
          .digest("hex"),
      );
    const before = hash(),
      input = Buffer.from(JSON.stringify({ home, ids: ["a", "b"] })).toString("base64");
    const rows = JSON.parse(
      execFileSync(process.execPath, ["--no-warnings", "-e", activityReader, input], {
        encoding: "utf8",
      }),
    );
    assert.deepEqual(rows, [
      {
        threadId: "a",
        turnId: "live",
        status: "inProgress",
        startedAt: 3,
        completedAt: 0,
        updatedAt: 3,
      },
    ]);
    assert.deepEqual(hash(), before);
    assert.throws(() =>
      execFileSync(
        process.execPath,
        [
          "--no-warnings",
          "-e",
          activityReader,
          Buffer.from(JSON.stringify({ home, ids: ["a' OR 1=1"] })).toString("base64"),
        ],
        { stdio: "pipe" },
      ),
    );
  } finally {
    rmSync(home, { recursive: true });
  }
});
