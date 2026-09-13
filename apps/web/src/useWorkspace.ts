import { useCallback, useEffect, useRef, useState } from "react";
import { workspaceSocket } from "./accountStorage.ts";
import { api, messageOf } from "./api";
import { mergeHistorySnapshot } from "./historyState";
import type { Approval, Attachment, History, HubEvent, Message, TurnSettings } from "./types";
export interface ChatState extends History {
  loading: boolean;
  loadingOlder: boolean;
  error: string;
  connection: string;
  revision: number;
  progress?: string;
}
const empty: ChatState = {
  messages: [],
  thread: { id: "", projectId: "", title: "Новый диалог", status: "idle", activeTurnId: null },
  approvals: [],
  nextBefore: null,
  hasMore: false,
  lastSeq: 0,
  loading: true,
  loadingOlder: false,
  error: "",
  connection: "connecting",
  revision: 0,
};
export function useWorkspace(threadId: string) {
  const [cache, setCache] = useState<Record<string, ChatState>>({});
  const cacheRef = useRef(cache);
  cacheRef.current = cache;
  const [epoch, setEpoch] = useState(0);
  const update = useCallback(
    (id: string, fn: (state: ChatState) => ChatState) =>
      setCache((old) => ({ ...old, [id]: fn(old[id] ?? { ...empty }) })),
    [],
  );
  const refresh = useCallback(
    async (id: string) => {
      const history = await api<History>(`/threads/${id}/history`);
      update(id, (s) => mergeHistorySnapshot(s, history));
      return history;
    },
    [update],
  );
  useEffect(() => {
    const focus = (event: Event) => {
      const detail = (event as CustomEvent<{ threadId: string; history: History }>).detail;
      update(detail.threadId, (s) => ({ ...s, ...detail.history, loading: false, error: "" }));
    };
    window.addEventListener("codex-focus-history", focus);
    return () => window.removeEventListener("codex-focus-history", focus);
  }, [update]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Epoch explicitly requests a fresh WebSocket connection.
  useEffect(() => {
    if (!threadId) return;
    let disposed = false,
      refreshing = false,
      ws: WebSocket | undefined,
      timer: ReturnType<typeof setTimeout> | undefined,
      attempt = 0,
      cursor = 0;
    const connect = () => {
      if (disposed || document.visibilityState === "hidden") return;
      update(threadId, (s) => ({ ...s, connection: attempt ? "reconnecting" : "connecting" }));
      ws = workspaceSocket(
        (location.protocol === "https:" ? "wss://" : "ws://") +
          location.host +
          "/api/events?threadId=" +
          encodeURIComponent(threadId) +
          "&after=" +
          cursor,
      );
      ws.onopen = () => {
        attempt = 0;
      };
      ws.onmessage = ({ data }) => {
        if (disposed) return;
        let event: HubEvent;
        try {
          event = JSON.parse(data);
        } catch {
          return;
        }
        if (event.type === "history.refresh") {
          refreshing = true;
          ws?.close();
          void refresh(threadId)
            .then((h) => {
              cursor = h.lastSeq;
              refreshing = false;
              connect();
            })
            .catch((e) => {
              refreshing = false;
              update(threadId, (s) => ({ ...s, error: messageOf(e) }));
              timer = setTimeout(connect, 5000);
            });
          return;
        }
        if (event.type === "connection.ready") {
          update(threadId, (s) => ({
            ...s,
            connection: "connected",
            thread: event.thread ?? s.thread,
            approvals: event.approvals ?? s.approvals,
          }));
          return;
        }
        if (event.type === "queue.changed")
          window.dispatchEvent(new CustomEvent("codex-queue-changed", { detail: threadId }));
        if (!event.seq || event.seq <= cursor) return;
        cursor = event.seq;
        if (event.type === "source.changed") {
          const current = cacheRef.current[threadId];
          if (
            current &&
            !current.contextTurn &&
            current.messages.length <= 20 &&
            !current.loadingOlder
          )
            void refresh(threadId).catch(() => {});
          else update(threadId, (s) => ({ ...s, hasNewer: true }));
        }
        update(threadId, (s) => {
          if ((event.seq ?? 0) <= s.lastSeq) return s;
          const p = event.payload ?? {},
            turnId = event.turnId ?? null,
            seq = event.seq ?? s.lastSeq,
            now = event.createdAt ?? new Date().toISOString();
          let messages = s.messages,
            thread = s.thread,
            approvals = s.approvals;
          let progress = s.progress;
          if (event.type === "turn.progress") progress = String(p.label ?? "");
          if (event.type === "turn.started") progress = "Обдумывает задачу";
          if (event.type === "turn.completed") progress = "";
          if (
            !s.contextTurn &&
            ["user.message", "assistant.delta", "assistant.completed"].includes(event.type)
          ) {
            const id = String(p.id),
              index = messages.findIndex((m) => m.id === id);
            const prior = index >= 0 ? messages[index] : undefined;
            const item: Message = {
              id,
              turnId: turnId ?? prior?.turnId ?? null,
              role: event.type === "user.message" ? "user" : "assistant",
              phase: String(p.phase ?? prior?.phase ?? ""),
              text:
                event.type === "assistant.delta"
                  ? (prior?.text ?? "") + String(p.text ?? "")
                  : String(p.text ?? ""),
              attachments: (p.attachments as Attachment[] | undefined) ?? prior?.attachments,
              firstSeq: prior?.firstSeq ?? seq,
              lastSeq: seq,
              createdAt: prior?.createdAt ?? now,
            };
            messages =
              index >= 0 ? messages.map((m, i) => (i === index ? item : m)) : [...messages, item];
          }
          if (event.type === "thread.settings")
            thread = { ...thread, settings: p.settings as TurnSettings };
          if (event.type === "turn.started") {
            thread = { ...thread, status: "running", activeTurnId: turnId, activitySource: "hub" };
            const index = messages.findLastIndex((m) => m.role === "user" && !m.turnId);
            if (index >= 0) messages = messages.map((m, i) => (i === index ? { ...m, turnId } : m));
          }
          if (event.type === "turn.completed") {
            thread = { ...thread, status: String(p.status), activeTurnId: null };
            approvals = [];
          }
          if (event.type === "session.state")
            thread = {
              ...thread,
              status: String(p.status ?? "unknown"),
              ...(p.activitySource
                ? {
                    activitySource: String(p.activitySource),
                    activeTurnId: typeof p.activeTurnId === "string" ? p.activeTurnId : null,
                  }
                : {}),
            };
          if (event.type === "approval.requested") {
            approvals = [
              ...approvals,
              {
                ...p,
                id: String(p.id),
                description: String(p.description),
                kind: String(p.kind),
              } as Approval,
            ];
            thread = { ...thread, status: "waiting_approval" };
          }
          if (event.type === "approval.resolved") {
            approvals = approvals.filter((a) => a.id !== p.id);
            thread = { ...thread, status: approvals.length ? "waiting_approval" : "running" };
          }
          const error =
            event.type === "error" ||
            (["session.state", "session.notice"].includes(event.type) && p.message)
              ? String(p.message ?? "Ошибка Codex")
              : s.error;
          return {
            ...s,
            messages,
            thread,
            approvals,
            progress,
            lastSeq: seq,
            error,
            revision:
              event.type === "result.created" || event.type === "turn.completed"
                ? s.revision + 1
                : s.revision,
          };
        });
      };
      ws.onclose = () => {
        if (disposed || refreshing) return;
        update(threadId, (s) => ({ ...s, connection: "reconnecting" }));
        const delay = Math.min(15000, 700 * 2 ** Math.min(attempt++, 5)) + Math.random() * 300;
        timer = setTimeout(connect, delay);
      };
      ws.onerror = () => ws?.close();
    };
    void (async () => {
      try {
        let state = cacheRef.current[threadId];
        if (!state || state.loading) {
          state = { ...empty, ...(await refresh(threadId)), loading: false };
        }
        cursor = state.lastSeq;
        connect();
      } catch (e) {
        update(threadId, (s) => ({
          ...s,
          loading: false,
          error: messageOf(e),
          connection: "offline",
        }));
      }
    })();
    const wake = () => {
      if (document.visibilityState === "visible") {
        if (timer) clearTimeout(timer);
        if (!ws || ws.readyState >= 2) connect();
      } else {
        if (timer) clearTimeout(timer);
        ws?.close();
      }
    };
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("online", wake);
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      ws?.close();
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("online", wake);
    };
  }, [threadId, epoch, refresh, update]);
  useEffect(() => {
    if (!threadId) return;
    let disposed = false,
      checking = false;
    const check = async () => {
      const current = cacheRef.current[threadId];
      if (
        disposed ||
        checking ||
        document.visibilityState !== "visible" ||
        !current?.sourceVersion ||
        (current.thread.activitySource !== "external" &&
          ["running", "starting", "waiting_approval"].includes(current.thread.status))
      )
        return;
      checking = true;
      try {
        const source = await api<{ version: number }>(`/threads/${threadId}/source`);
        if (!disposed && source.version !== current.sourceVersion) {
          if (!current.contextTurn && current.messages.length <= 20 && !current.loadingOlder)
            await refresh(threadId);
          else update(threadId, (state) => ({ ...state, hasNewer: true }));
        }
      } catch {
        /* The saved conversation stays readable while the computer is offline. */
      } finally {
        checking = false;
      }
    };
    const wake = () => void check();
    const initial = setTimeout(wake, 500);
    const timer = setInterval(wake, 12000);
    document.addEventListener("visibilitychange", wake);
    return () => {
      disposed = true;
      clearTimeout(initial);
      clearInterval(timer);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [threadId, refresh, update]);
  const older = useCallback(async () => {
    const state = cacheRef.current[threadId];
    if (!state?.nextBefore || state.loadingOlder) return;
    update(threadId, (s) => ({ ...s, loadingOlder: true }));
    try {
      const history = await api<History>(
        `/threads/${threadId}/history?before=${encodeURIComponent(state.nextBefore)}`,
      );
      update(threadId, (s) => {
        const ids = new Set(s.messages.map((m) => m.id));
        return {
          ...s,
          messages: [...history.messages.filter((m) => !ids.has(m.id)), ...s.messages],
          nextBefore: history.nextBefore,
          hasMore: history.hasMore,
          loadingOlder: false,
        };
      });
    } catch (e) {
      update(threadId, (s) => ({ ...s, loadingOlder: false, error: messageOf(e) }));
    }
  }, [threadId, update]);
  return {
    state: cache[threadId] ?? empty,
    older,
    reconnect: () => setEpoch((n) => n + 1),
    refresh: () => refresh(threadId),
    clearError: () => update(threadId, (s) => ({ ...s, error: "" })),
  };
}
