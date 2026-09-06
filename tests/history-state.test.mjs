import assert from "node:assert/strict";
import test from "node:test";
import { mergeHistorySnapshot } from "../apps/web/src/historyState.ts";

const thread = {
  id: "thread",
  projectId: "project",
  title: "Chat",
  status: "running",
  activeTurnId: "turn",
};
const message = (id, text, seq) => ({
  id,
  text,
  lastSeq: seq,
  firstSeq: seq,
  turnId: "turn",
  role: "assistant",
  phase: "commentary",
  createdAt: "",
});
const snapshot = {
  messages: [message("reply", "First", 5)],
  thread,
  approvals: [],
  nextBefore: null,
  hasMore: false,
  lastSeq: 5,
};
test("late history snapshot preserves newer streamed replies and completion", () => {
  const state = {
    ...snapshot,
    messages: [message("reply", "First and second", 7), message("next", "New reply", 8)],
    thread: { ...thread, status: "completed", activeTurnId: null },
    lastSeq: 9,
    loading: false,
    loadingOlder: false,
    error: "",
    connection: "connected",
    revision: 1,
  };
  const merged = mergeHistorySnapshot(state, snapshot);
  assert.deepEqual(
    merged.messages.map((m) => m.text),
    ["First and second", "New reply"],
  );
  assert.equal(merged.lastSeq, 9);
  assert.equal(merged.thread.status, "completed");
});
test("fresh device receives complete snapshot without inheriting another conversation", () => {
  const state = {
    ...snapshot,
    messages: [],
    lastSeq: 0,
    loading: true,
    loadingOlder: false,
    error: "",
    connection: "connecting",
    revision: 0,
  };
  assert.deepEqual(mergeHistorySnapshot(state, snapshot).messages, snapshot.messages);
});
