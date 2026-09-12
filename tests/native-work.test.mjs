import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { gptHistory } from "../apps/hub/dist/gpt-history.js";
import { readNativeInventory } from "../apps/hub/dist/native-inventory.js";
import { NativeWorkStore } from "../apps/hub/dist/native-work.js";
import { Store } from "../apps/hub/dist/store.js";
import { handoffFixture } from "./handoff-fixture.mjs";

test("native inventory isolates project skills, reports unavailable methods and omits credentials", async () => {
  const calls = [];
  const groups = await readNativeInventory(async (method, params) => {
    calls.push({ method, params });
    if (method === "skills/list")
      return {
        data: [
          {
            cwd: "c:\\Project\\",
            skills: [
              { name: "files", description: "Read files", enabled: true, private: "SECRET" },
            ],
          },
          { cwd: "C:/Other", skills: [{ name: "WRONG_PROJECT" }] },
        ],
      };
    if (method === "plugin/list") throw Error("SECRET native diagnostics");
    return {
      data: [
        {
          name: "Calendar",
          authStatus: "notLoggedIn",
          tools: { read: {} },
          credentials: "SECRET",
          resources: [{ uri: "SECRET" }],
        },
      ],
      nextCursor: "PRIVATE_CURSOR",
    };
  }, "C:/Project");
  assert.equal(groups[0].items[0].name, "files");
  assert.equal(groups[1].available, false);
  assert.equal(groups[2].items[0].state, "Требуется вход");
  assert.equal(groups[2].more, true);
  assert.doesNotMatch(JSON.stringify(groups), /SECRET|WRONG_PROJECT|PRIVATE_CURSOR/);
  assert(calls.every((call) => !call.method.includes("resume") && !call.method.includes("start")));
});

test("visible unsupported GPT parts remain source-bound without private content", () => {
  const node = (id, parent, role, content, channel = "final", metadata = {}) => ({
    id,
    parent,
    message: { id, author: { role }, channel, content, metadata },
  });
  const value = {
    current_node: "mixed",
    mapping: {
      audio: node("audio", null, "user", { content_type: "audio", asset_pointer: "PRIVATE_URL" }),
      hidden: node(
        "hidden",
        "audio",
        "assistant",
        { content_type: "thoughts", parts: ["PRIVATE_THOUGHT"] },
        null,
      ),
      analysis: node(
        "analysis",
        "hidden",
        "assistant",
        { content_type: "text", parts: ["PRIVATE_ANALYSIS"] },
        "analysis",
      ),
      tool: node("tool", "analysis", "tool", { content_type: "text", parts: ["PRIVATE_TOOL"] }),
      mixed: node("mixed", "tool", "assistant", {
        content_type: "multimodal_text",
        parts: [
          "Visible",
          { content_type: "video", url: "PRIVATE_URL" },
          { content_type: "novel_type_PRIVATE", opaque: "PRIVATE_DATA" },
          { content_type: "image_asset_pointer", asset_pointer: "file-service://file-image" },
        ],
      }),
    },
  };
  const messages = gptHistory(value);
  assert.deepEqual(
    messages.map((m) => m.id),
    ["audio", "mixed"],
  );
  assert.deepEqual(messages[0].unsupported, ["audio"]);
  assert.deepEqual(messages[1].unsupported, ["video", "other"]);
  assert.equal(messages[1].text, "Visible");
  assert.equal(messages[1].files.length, 1);
  assert.doesNotMatch(JSON.stringify(messages), /PRIVATE/);
  value.mapping.mixed.message.metadata.is_visually_hidden_from_conversation = true;
  assert.equal(gptHistory(value).length, 1);
});

test("native snapshots and logs survive reconstruction, keep a bounded tail and isolate identities", () => {
  const store = new Store(":memory:");
  const thread = store.createThread("p", randomUUID(), "test"),
    other = store.createThread("p", randomUUID(), "other");
  let work = new NativeWorkStore(store);
  try {
    work.update(thread.id, "turn", "plan", {
      plan: [
        { step: "Check", status: "inProgress" },
        { step: "Invalid", status: "invented" },
      ],
      private: "HIDDEN",
    });
    work.update(thread.id, "turn", "usage", {
      tokenUsage: {
        last: { inputTokens: 123, outputTokens: 20, cachedInputTokens: 80, totalTokens: 143 },
        total: { totalTokens: 999999 },
        modelContextWindow: null,
      },
    });
    work.update(thread.id, "turn", "usage", { tokenUsage: {} }); // sparse event cannot clear canonical data
    work.update(thread.id, "turn", "diff", { diff: "x".repeat(260000) });
    work.command(thread.id, "turn", "cmd", { command: "build", status: "inProgress" });
    work.command(thread.id, "turn", "cmd", {}, "a".repeat(300000) + "TAIL");
    assert.equal(work.read(other.id, "turn", "cmd"), null);
    assert.equal(work.read(thread.id, "other-turn", "cmd"), null);
    assert.equal(work.read(thread.id, "turn", "cmd").text.length, 64000);
    assert.equal(work.read(thread.id, "turn", "cmd").truncated, true);
    assert(work.read(thread.id, "turn", "cmd").text.endsWith("TAIL"));
    work.close();
    work = new NativeWorkStore(store);
    assert.equal(work.read(thread.id, "turn", "cmd").status, "unknown");
    assert.equal(work.read(thread.id, "turn", "cmd", true).text.length, 256000);
    const snapshot = work.snapshot(thread.id, "turn");
    assert.equal(snapshot.plan.steps.length, 1);
    assert.equal(snapshot.usage.total, 143);
    assert.equal(snapshot.usage.capacity, null);
    assert.equal(snapshot.diff.truncated, true);
    assert.doesNotMatch(JSON.stringify(snapshot), /HIDDEN/);
    work.command(thread.id, "turn", "cmd", {
      status: "completed",
      exitCode: 0,
      aggregatedOutput: "\u001b[31mcanonical final\u001b[0m",
    });
    assert.equal(work.read(thread.id, "turn", "cmd").text, "canonical final");
    assert.equal(work.read(thread.id, "turn", "cmd").truncated, false);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM events").get().n, 0);
  } finally {
    work.close();
    store.close();
  }
});

test("native events feed progress and authenticated log downloads; account events stay machine-scoped", async () => {
  const f = await handoffFixture();
  try {
    const r = {
      rpc: f.rpc,
      loaded: new Set([f.thread.id]),
      active: new Set(),
      machineId: "pc",
      touched: 0,
    };
    const emit = (method, p) =>
      f.sessions.notification(r, method, {
        threadId: f.thread.codexThreadId,
        turnId: "turn",
        ...p,
      });
    emit("turn/started", { turn: { id: "turn" } });
    emit("item/started", {
      item: { id: "cmd", type: "commandExecution", command: "pnpm test", status: "inProgress" },
    });
    emit("item/commandExecution/outputDelta", { itemId: "cmd", delta: "working" });
    emit("turn/plan/updated", { plan: [{ step: "Validate", status: "inProgress" }] });
    emit("thread/tokenUsage/updated", {
      tokenUsage: {
        last: { inputTokens: 100, outputTokens: 1, cachedInputTokens: 0, totalTokens: 101 },
        modelContextWindow: 1000,
      },
    });
    emit("turn/diff/updated", { diff: "diff --git a/x b/x\n+change" });
    const url = `/api/threads/${f.thread.id}/commands/cmd?turnId=turn`;
    assert.equal((await f.app.inject({ url })).statusCode, 401);
    const log = await f.app.inject({ url, headers: f.headers });
    assert.equal(log.json().text, "working");
    const progress = (
      await f.app.inject({ url: `/api/threads/${f.thread.id}/progress`, headers: f.headers })
    ).json();
    assert.equal(progress.items[0].itemId, "cmd");
    assert.equal(progress.plan.steps[0].text, "Validate");
    assert.equal(progress.usage.capacity, 1000);
    assert.match(progress.diff.text, /change/);
    const download = await f.app.inject({ url: url + "&download=1", headers: f.headers });
    assert.equal(download.body, "working");
    assert.match(download.headers["content-disposition"], /attachment/);
    f.sessions.notification(r, "account/rateLimits/updated", {
      rateLimits: { credentials: "PRIVATE_ACCOUNT" },
    });
    assert.equal(f.sessions.usageRevision.get("pc"), 1);
    const navigation = (await f.app.inject({ url: "/api/navigation", headers: f.headers })).body;
    assert.doesNotMatch(navigation, /PRIVATE_ACCOUNT|credentials/);
    assert.equal(JSON.parse(navigation).usageRevision.pc, 1);
    emit("item/completed", {
      item: {
        type: "commandExecution",
        id: "cmd",
        command: "pnpm test",
        status: "completed",
        exitCode: 0,
        aggregatedOutput: "done",
      },
    });
    const result = f.store.results(f.thread.id).items[0];
    const output = (
      await f.app.inject({
        url: `/api/threads/${f.thread.id}/results/${result.id}/output`,
        headers: f.headers,
      })
    ).json();
    assert.equal(output.text, "done");
    assert.match(output.downloadUrl, /download=1/);
  } finally {
    await f.close();
  }
});

test("late native work from a loaded writer survives a removed catalog project", async () => {
  const f = await handoffFixture();
  try {
    const runtime = {
      rpc: f.rpc,
      loaded: new Set([f.thread.id]),
      active: new Set(),
      machineId: "pc",
      touched: 0,
    };
    f.sessions.catalog.projects = () => [];
    const event = {
      threadId: f.thread.codexThreadId,
      turnId: "late-turn",
      plan: [{ step: "Complete", status: "completed" }],
    };
    assert.doesNotThrow(() => f.sessions.notification(runtime, "turn/plan/updated", event));
    assert.equal(
      f.sessions.nativeWork.snapshot(f.thread.id, "late-turn").plan.steps[0].text,
      "Complete",
    );
    f.sessions.notification({ ...runtime, loaded: new Set() }, "turn/plan/updated", {
      ...event,
      turnId: "foreign",
    });
    assert.equal(f.sessions.nativeWork.snapshot(f.thread.id, "foreign").plan, undefined);
  } finally {
    await f.close();
  }
});
