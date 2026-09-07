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

export function useGptHistory(selected: string, onError: (message: string) => void) {
  const [page, setPage] = useState<GptCachedChat | undefined>(() => gptCache.chats[selected]);
  const [loading, setLoading] = useState(false);
  const scroll = useRef<HTMLDivElement>(null),
    sticky = useRef(page?.sticky ?? true);
  const selectedRef = useRef(selected),
    mounted = useRef(true);
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
    const cached = gptCache.chats[selected];
    setPage(cached);
    sticky.current = cached?.sticky ?? true;
    setLoading(false);
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
    async (id: string, older?: string, force = false): Promise<void> => {
      if (!id) return;
      if (pending.current.has(id)) {
        await pending.current.get(id);
        if (!older && !force) return;
      }
      const cached = gptCache.chats[id];
      if (!older && !force && cached && Date.now() - cached.checkedAt < 15000) return;
      const epoch = gptCacheEpoch(),
        serial = beginGptHistory(id);
      const task = (async () => {
        if (mounted.current && selectedRef.current === id && (older || !cached)) setLoading(true);
        try {
          const query = new URLSearchParams();
          if (older) query.set("before", older);
          else if (cached?.revision) {
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
          gptCache.chats[id] = next;
          saveGptCache();
          if (!mounted.current || selectedRef.current !== id) return;
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
          throw error;
        } finally {
          if (mounted.current && selectedRef.current === id) setLoading(false);
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
      if (!document.hidden) void history(selected).catch((error) => onError(messageOf(error)));
    };
    refresh();
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
  }, [selected, history, onError]);
  return {
    messages: page?.messages ?? [],
    before: page?.before ?? null,
    loading,
    scroll,
    sticky,
    history,
    rememberScroll,
  };
}
