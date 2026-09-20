import type { GptHistoryPage } from "@codex-web/shared";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ApiError, api, messageOf } from "./api";
import {
  beginGptHistory,
  currentGptHistory,
  type GptCachedChat,
  gptCache,
  gptCacheEpoch,
  saveGptCache,
} from "./gptCache";
import { mergeGptHistory } from "./gptState";

export function useGptHistory(selected: string) {
  const [page, setPage] = useState<GptCachedChat | undefined>(() => gptCache.chats[selected]);
  const [loading, setLoading] = useState(false);
  const [revalidating, setRevalidating] = useState(false);
  const [error, setError] = useState("");
  const scroll = useRef<HTMLDivElement>(null),
    sticky = useRef(page?.sticky ?? true);
  const pageScope = useRef(selected);
  const selectedRef = useRef(selected),
    mounted = useRef(true);
  const failures = useRef({ id: "", epoch: -1, count: 0, since: 0 });
  const pending = useRef(new Map<string, Promise<void>>());
  selectedRef.current = selected;
  const rememberScroll = useCallback((id = selectedRef.current) => {
    const cached = gptCache.chats[id];
    if (!cached || !scroll.current || !scroll.current.clientHeight) return;
    cached.scrollTop = scroll.current.scrollTop;
    cached.sticky = sticky.current;
    saveGptCache();
  }, []);
  useLayoutEffect(() => {
    mounted.current = true;
    pageScope.current = selected;
    const cached = gptCache.chats[selected];
    setPage(cached);
    sticky.current = cached?.sticky ?? true;
    setLoading(!!selected && !cached);
    setError("");
    return () => {
      rememberScroll(selected);
      mounted.current = false;
    };
  }, [selected, rememberScroll]);
  useLayoutEffect(() => {
    if (page && scroll.current) {
      if (sticky.current) scroll.current.scrollTop = scroll.current.scrollHeight;
    }
  }, [page]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Restore after cached messages have committed to the selected pane.
  useLayoutEffect(() => {
    const cached = gptCache.chats[selected];
    if (scroll.current && cached && !cached.sticky) scroll.current.scrollTop = cached.scrollTop;
  }, [selected, page?.anchor]);
  useEffect(() => {
    const save = () => rememberScroll();
    window.addEventListener("pagehide", save);
    document.addEventListener("visibilitychange", save);
    return () => {
      window.removeEventListener("pagehide", save);
      document.removeEventListener("visibilitychange", save);
    };
  }, [rememberScroll]);
  const history = useCallback(
    async (
      id: string,
      older?: string,
      force = false,
      messageId?: string,
      preferCached = false,
    ): Promise<void> => {
      if (!id) return;
      if (pending.current.has(id)) {
        await pending.current.get(id);
        if (!older && !force && !messageId) return;
      }
      const cached = gptCache.chats[id];
      if (
        !older &&
        !force &&
        !messageId &&
        cached &&
        (cached.contextMessage || Date.now() - cached.checkedAt < 15000)
      )
        return;
      const epoch = gptCacheEpoch(),
        serial = beginGptHistory(id);
      const reportFailure = (message: string, transient: boolean) => {
        if (epoch !== gptCacheEpoch() || !currentGptHistory(id, serial)) return;
        if (failures.current.id !== id || failures.current.epoch !== epoch)
          failures.current = { id, epoch, count: 0, since: Date.now() };
        const failure = failures.current;
        if (!failure.count) failure.since = Date.now();
        failure.count++;
        // Existing periodic reads recover cached history; do not add more native requests.
        const quiet =
          transient &&
          cached &&
          !older &&
          !messageId &&
          (failure.count < 3 || Date.now() - failure.since < 30000);
        if (mounted.current && selectedRef.current === id) setError(quiet ? "" : message);
      };
      const task = (async () => {
        if (mounted.current && selectedRef.current === id && (older || !cached)) setLoading(true);
        if (mounted.current && selectedRef.current === id) {
          setRevalidating(true);
          if (!cached) setError("");
        }
        try {
          const query = new URLSearchParams();
          if (preferCached && !older && !messageId) query.set("cached", "1");
          if (messageId) query.set("messageId", messageId);
          else if (older) query.set("before", older);
          else if (cached?.revision && !cached.contextMessage) {
            query.set("known", cached.revision);
            if (cached.anchor) query.set("anchor", cached.anchor);
            if (cached.prefix) query.set("prefix", cached.prefix);
          }
          const data = await api<GptHistoryPage>(
            "/gpt/conversations/" + encodeURIComponent(id) + "/messages?" + query,
          );
          if (epoch !== gptCacheEpoch() || !currentGptHistory(id, serial)) return;
          const current = gptCache.chats[id];
          const next = mergeGptHistory(current, data, !!older);
          if (messageId) {
            next.sticky = false;
            if (mounted.current && selectedRef.current === id) sticky.current = false;
          }
          if (force && !messageId && !older && current?.contextMessage) {
            next.sticky = true;
            if (mounted.current && selectedRef.current === id) sticky.current = true;
          }
          gptCache.chats[id] = next;
          saveGptCache();
          if (!mounted.current || selectedRef.current !== id) return;
          if (data.stale && data.refreshMessage) reportFailure(data.refreshMessage, true);
          else {
            failures.current = { id, epoch, count: 0, since: 0 };
            setError("");
          }
          const oldHeight = scroll.current?.scrollHeight ?? 0;
          setPage(next);
          if (older)
            requestAnimationFrame(() => {
              if (scroll.current && selectedRef.current === id) {
                scroll.current.scrollTop += scroll.current.scrollHeight - oldHeight;
                rememberScroll(id);
              }
            });
        } catch (error) {
          if (error instanceof ApiError && error.code === "GPT_HISTORY_CHANGED") {
            // A native branch changed during pagination. Refresh the tail without mixing branches.
            delete gptCache.chats[id];
            pending.current.delete(id);
            await history(id, undefined, true);
            return;
          }
          const transient =
            error instanceof ApiError &&
            (error.status === 0 ||
              [
                "GPT_HISTORY_RATE_LIMITED",
                "GPT_HISTORY_UNAVAILABLE",
                "GPT_CONNECTION_LOST",
                "TRANSPORT_UNAVAILABLE",
                "REQUEST_FAILED",
                "INVALID_RESPONSE",
              ].includes(error.code)) &&
            ![401, 403, 404].includes(error.status);
          reportFailure(messageOf(error), transient);
          throw error;
        } finally {
          if (mounted.current && selectedRef.current === id) {
            setLoading(false);
            setRevalidating(false);
          }
        }
      })();
      pending.current.set(id, task);
      try {
        await task;
      } finally {
        if (pending.current.get(id) === task) pending.current.delete(id);
      }
    },
    [rememberScroll],
  );
  useEffect(() => {
    const refresh = () => {
      if (!document.hidden) void history(selected).catch(() => {});
    };
    if (!document.hidden) void history(selected, undefined, false, undefined, true).catch(() => {});
    const timer = setInterval(refresh, 15000);
    window.addEventListener("online", refresh);
    window.addEventListener("pageshow", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener("online", refresh);
      window.removeEventListener("pageshow", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [selected, history]);
  const currentPage =
    gptCache.chats[selected] ?? (pageScope.current === selected ? page : undefined);
  return {
    ready: !!currentPage,
    stale: !!currentPage?.stale,
    revalidating,
    error,
    clearError: () => setError(""),
    messages: currentPage?.messages ?? [],
    contextMessage: currentPage?.contextMessage,
    hasNewer: currentPage?.hasNewer,
    before: currentPage?.before ?? null,
    loading,
    scroll,
    sticky,
    history,
    rememberScroll,
  };
}
