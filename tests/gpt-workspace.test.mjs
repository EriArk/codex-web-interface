import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { deploymentBlockers } from "../apps/hub/dist/deployment-status.js";
import { GptWorkspaceWork, workspaceInput } from "../apps/hub/dist/gpt-workspace.js";
import { Store } from "../apps/hub/dist/store.js";
import {
  canvasFields,
  canvasVersion,
  mutateSchedule,
  restoreCanvas,
  scheduledFields,
  scheduledRead,
} from "../ops/gpt/browser-workspace.mjs";

const rev = "a".repeat(64);
const scheduled = () => ({
  id: "task-1",
  title: "Read",
  prompt: "Read the news",
  enabled: true,
  schedule: "BEGIN:VEVENT\nRRULE:FREQ=DAILY\nEND:VEVENT",
  displaySchedule: "Daily",
  timezone: "Asia/Jerusalem",
  timing: "exact_schedule",
  nextRuns: [],
  lastRun: null,
  conversationId: null,
  eventDriven: false,
  canEdit: true,
  canDelete: true,
  revision: rev,
});
const canvas = () => ({
  id: "doc-1",
  conversationId: "chat-1",
  title: "Draft",
  type: "document",
  content: "Current",
  version: 3,
  revision: rev,
});
const pause = { kind: "schedule", id: "task-1", action: "pause", revision: rev };
function fixture(handler, canStart = () => true) {
  const store = new Store(":memory:");
  const service = new GptWorkspaceWork(store, handler, canStart);
  return {
    store,
    service,
    async close() {
      await service.close();
      store.close();
    },
  };
}
test("scheduled mutation is durable and exact retries do not replay; canonical result confirms completion", async () => {
  let item = scheduled(),
    writes = 0;
  const f = fixture(async (path, body) => {
    if (path === "/active") return {};
    if (path.startsWith("/scheduled/item")) return { item };
    if (path === "/workspace-mutation") {
      writes++;
      item = { ...item, enabled: false, revision: "b".repeat(64) };
      return { dispatched: true };
    }
    throw Error(path);
  });
  try {
    const id = randomUUID();
    f.service.start(id, pause);
    await f.service.close();
    assert.equal(f.service.get(id).state, "completed");
    assert.equal(f.service.blocked(), false);
    f.service.start(id, pause);
    assert.equal(writes, 1);
    assert.throws(() => f.service.start(id, { ...pause, action: "resume" }), /другими/);
  } finally {
    await f.close();
  }
});
test("lost acknowledgement survives restart, blocks other writes and checks without replay", async () => {
  let item = scheduled(),
    writes = 0;
  const json = async (path) => {
    if (path === "/active") return {};
    if (path.startsWith("/scheduled/item")) return { item };
    writes++;
    item = { ...item, enabled: false };
    throw Error("lost response");
  };
  const f = fixture(json),
    id = randomUUID();
  try {
    f.service.start(id, pause);
    await f.service.close();
    assert.equal(f.service.get(id).state, "unknown");
    assert.throws(() => f.service.start(randomUUID(), pause), /Сначала/);
    const resumed = new GptWorkspaceWork(f.store, json, () => true);
    assert.equal(resumed.blocked(), true);
    assert(deploymentBlockers(f.store).some((b) => b.kind === "gpt_workspace"));
    assert.equal(await resumed.check(id), true);
    assert.equal(resumed.get(id).state, "completed");
    assert.equal(writes, 1);
  } finally {
    await f.close();
  }
});
test("unknown is not success when unchanged; manual acknowledgement needs a readable canonical state", async () => {
  let readable = true;
  const f = fixture(async (path) => {
    if (path === "/active") return {};
    if (path.startsWith("/scheduled/item")) {
      if (!readable) throw Error("offline");
      return { item: scheduled() };
    }
    return { dispatched: true };
  });
  try {
    const id = randomUUID();
    f.service.start(id, pause);
    await f.service.close();
    assert.equal(f.service.get(id).state, "unknown");
    assert.equal(await f.service.check(id), false);
    readable = false;
    await assert.rejects(f.service.checked(id));
    assert.equal(f.service.blocked(), true);
    readable = true;
    await f.service.checked(id);
    assert.equal(f.service.blocked(), false);
    assert.equal(f.service.get(id).state, "failed");
  } finally {
    await f.close();
  }
});
test("in-flight operations cannot be manually released and maintenance sees active work", async () => {
  const entered = Promise.withResolvers(),
    pending = Promise.withResolvers();
  const f = fixture(async (path) => {
    if (path === "/active") return {};
    if (path.startsWith("/scheduled/item")) return { item: scheduled() };
    entered.resolve();
    return pending.promise;
  });
  try {
    const id = randomUUID();
    f.service.start(id, pause);
    await entered.promise;
    assert.deepEqual(f.service.counts(), { active: 1, unknown: 0 });
    assert(deploymentBlockers(f.store).some((b) => b.kind === "gpt_workspace" && b.count === 1));
    assert.equal(await f.service.check(id), false);
    await assert.rejects(f.service.checked(id), /Дождись/);
    pending.resolve({ dispatched: false });
    await f.service.close();
    assert.equal(f.service.get(id).state, "failed");
  } finally {
    pending.resolve({ dispatched: false });
    await f.close();
  }
});
test("stale revisions, native activity, readonly and unavailable state fail before dispatch", async () => {
  for (const scenario of ["stale", "active", "readonly", "offline"]) {
    let writes = 0;
    const f = fixture(async (path) => {
      if (path === "/active") return { generating: scenario === "active" };
      if (path.startsWith("/scheduled/item")) {
        if (scenario === "offline") throw Error("offline");
        return {
          item: {
            ...scheduled(),
            revision: scenario === "stale" ? "b".repeat(64) : rev,
            canEdit: scenario !== "readonly",
          },
        };
      }
      writes++;
      return { dispatched: true };
    });
    try {
      const id = randomUUID();
      f.service.start(id, pause);
      await f.service.close();
      assert.equal(writes, 0, scenario);
      assert.equal(f.service.get(id).state, "failed");
    } finally {
      await f.close();
    }
  }
});
test("Canvas restore stays bound to conversation and exact content of the requested version", async () => {
  let current = canvas(),
    writes = 0;
  const f = fixture(async (path, body) => {
    if (path === "/active") return {};
    if (path.startsWith("/canvas?")) return { items: [current] };
    if (path.startsWith("/canvas/version")) return { ...canvas(), version: 1, content: "Original" };
    writes++;
    assert.equal(body.conversationId, "chat-1");
    current = { ...canvas(), version: 4, content: "Original" };
    return { dispatched: true };
  });
  try {
    const id = randomUUID();
    f.service.start(id, {
      kind: "canvas",
      action: "restore",
      conversationId: "chat-1",
      id: "doc-1",
      revision: rev,
      version: 1,
      confirm: true,
    });
    await f.service.close();
    assert.equal(f.service.get(id).state, "completed");
    assert.equal(writes, 1);
    await assert.rejects(f.service.canvases("different-chat"), /другому чату/);
  } finally {
    await f.close();
  }
});
test("strict inputs reject arbitrary native methods, malformed identifiers, missing confirmations and invalid timezone", () => {
  for (const input of [
    { ...pause, id: "../other" },
    { ...pause, action: "POST" },
    { ...pause, action: "delete" },
    { ...pause, extra: "secret" },
    {
      ...pause,
      action: "save",
      title: "a",
      prompt: "b",
      schedule: "x",
      enabled: true,
      timezone: "not-a-zone",
    },
  ])
    assert.equal(workspaceInput.safeParse(input).success, false);
});
const raw = () => ({
  id: "task-1",
  title: "Test",
  prompt: "Remember",
  is_enabled: true,
  schedule: "BEGIN:VEVENT\nRRULE:FREQ=DAILY\nEND:VEVENT",
  display_schedule: "Daily",
  default_timezone: "Asia/Jerusalem",
  timing_mode: "exact_schedule",
  next_run_times: ["2026-10-01T10:00:00Z", "bad"],
  last_run_time: null,
  conversation_id: null,
  webhook_triggers: [],
  current_user_role: "owner",
  can_delete: true,
  notifications_enabled: true,
  email_enabled: true,
  last_edited_by_display_name: "SECRET",
  updated_at: "one",
});
function pageFor(handler) {
  return {
    url: () => "https://chatgpt.com/",
    locator: () => ({ isVisible: async () => false }),
    evaluate: async (_fn, { path, body }) => handler(path, body),
  };
}
test("native projection excludes account metadata and invalid dates and hashes permissions", () => {
  const item = scheduledFields(raw());
  assert(!JSON.stringify(item).includes("SECRET"));
  assert.equal(item.nextRuns.length, 1);
  assert.notEqual(item.revision, scheduledFields({ ...raw(), can_delete: false }).revision);
  assert.throws(() =>
    canvasFields({ ...canvas(), textdoc_type: "document", version: 0 }, "chat-1"),
  );
});
test("native save preserves notification options and verified timing; stale save never dispatches", async () => {
  const native = raw(),
    calls = [];
  const page = pageFor((path, body) => {
    calls.push({ path, body });
    return { status: 200, data: native, dispatched: body !== undefined };
  });
  const input = { ...scheduledFields(native), action: "save", title: "Updated" };
  assert.deepEqual(await mutateSchedule(page, input), { dispatched: true, code: null });
  assert.equal(calls.at(-1).path, "/automations/save");
  assert.equal(calls.at(-1).body.notifications_enabled, true);
  assert.equal(calls.at(-1).body.email_enabled, true);
  assert.equal(calls.at(-1).body.timing_mode, 0);
  calls.length = 0;
  assert.equal(
    (await mutateSchedule(page, { ...input, revision: "b".repeat(64) })).dispatched,
    false,
  );
  assert.equal(calls.length, 1);
});
test("native Canvas history reads version-one from the next diff; foreign IDs and future versions never write", async () => {
  const doc = { id: "doc-1", title: "Draft", textdoc_type: "document", content: "Now", version: 3 };
  const paths = [];
  const page = pageFor((path, body) => {
    paths.push({ path, body });
    return {
      status: 200,
      data: path.includes("/textdocs")
        ? [doc]
        : { content_before: "Original", content_after: "Second" },
      dispatched: false,
    };
  });
  assert.equal((await canvasVersion(page, "chat-1", "doc-1", 1)).content, "Original");
  assert.equal(paths.at(-1).path, "/textdoc/doc-1/diff/2");
  await assert.rejects(canvasVersion(page, "chat-1", "foreign", 1));
  await assert.rejects(canvasVersion(page, "chat-1", "doc-1", 4));
  assert.equal(
    (
      await restoreCanvas(page, {
        id: "foreign",
        conversationId: "chat-1",
        revision: rev,
        version: 1,
      })
    ).dispatched,
    false,
  );
  assert(!paths.some((p) => p.body));
});

test("native HTTP 201 confirms mutation and HTTP 410 means a deleted scheduled task", async () => {
  const page = pageFor((path, body) =>
    body
      ? { status: 201, data: {}, dispatched: true }
      : { status: 200, data: raw(), dispatched: false },
  );
  assert.deepEqual(
    await mutateSchedule(page, {
      id: "task-1",
      revision: scheduledFields(raw()).revision,
      action: "pause",
    }),
    { dispatched: true, code: null },
  );
  assert.equal(
    await scheduledRead(
      pageFor(() => ({ status: 410, data: null, dispatched: false })),
      "task-1",
    ),
    null,
  );
  await assert.rejects(
    scheduledRead(
      pageFor(() => ({ status: 503, data: null, dispatched: false })),
      "task-1",
    ),
  );
});
