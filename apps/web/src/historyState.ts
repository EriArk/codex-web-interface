import type { History } from "./types";
import type { ChatState } from "./useWorkspace";

/** A history response may arrive after newer WebSocket events on an already open client. */
export function mergeHistorySnapshot(state: ChatState, history: History): ChatState {
  const newer = state.messages.filter((message) => message.lastSeq > history.lastSeq);
  const byId = new Map(newer.map((message) => [message.id, message]));
  const messages = history.messages.map((message) => byId.get(message.id) ?? message);
  const ids = new Set(messages.map((message) => message.id));
  messages.push(...newer.filter((message) => !ids.has(message.id)));
  return {
    ...state,
    ...history,
    messages,
    thread: state.lastSeq > history.lastSeq ? state.thread : history.thread,
    approvals: state.lastSeq > history.lastSeq ? state.approvals : history.approvals,
    lastSeq: Math.max(state.lastSeq, history.lastSeq),
    contextTurn: history.contextTurn ?? "",
    hasNewer: history.hasNewer ?? false,
    loading: false,
    error: "",
    revision: state.revision + 1,
  };
}
