import type { CollaborationCatalog } from "@codex-web/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { pageWorkspace, accountLocalStorage as storage } from "./accountStorage";
import { api } from "./api";

export type SpaceWindow =
  | { kind: "create" | "invitations" }
  | { kind: "accept" | "settings" | "chat"; id: string };
export function useCollaborationSpaces() {
  const [catalog, setCatalog] = useState<CollaborationCatalog>({ spaces: [], invitations: [] });
  const [ready, setReady] = useState(false);
  const [mode, setMode] = useState<"personal" | "spaces">(() => {
    try {
      return storage.getItem("codex-spaces-mode") === "spaces" ? "spaces" : "personal";
    } catch {
      return "personal";
    }
  });
  const [selectedId, select] = useState("");
  const [entry, setEntry] = useState(0);
  const [window, open] = useState<SpaceWindow | null>(null);
  const pending = useRef<Promise<void> | null>(null);
  const live = useRef(true);
  const refresh = useCallback(function refresh(fresh = false): Promise<void> {
    if (!pageWorkspace) return Promise.resolve();
    if (pending.current)
      return fresh ? pending.current.catch(() => {}).then(() => refresh()) : pending.current;
    pending.current = api<CollaborationCatalog>("/team/spaces")
      .then((data) => {
        if (!live.current) return;
        setCatalog(data);
        setReady(true);
        select((id) => (data.spaces.some((s) => s.id === id) ? id : ""));
        open((w) => (w?.kind === "chat" && !data.spaces.some((s) => s.id === w.id) ? null : w));
      })
      .finally(() => {
        pending.current = null;
      });
    return pending.current;
  }, []);
  useEffect(() => {
    live.current = true;
    const update = () => {
      if (!document.hidden) void refresh().catch(() => {});
    };
    update();
    const timer = globalThis.setInterval(update, 10_000);
    globalThis.addEventListener("focus", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      live.current = false;
      clearInterval(timer);
      globalThis.removeEventListener("focus", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, [refresh]);
  return {
    enabled: !!pageWorkspace,
    catalog,
    ready,
    mode,
    selectedId,
    entry,
    select,
    window,
    open,
    refresh,
    setMode(value: "personal" | "spaces") {
      if (value !== mode) setEntry((v) => v + 1);
      setMode(value);
      try {
        storage.setItem("codex-spaces-mode", value);
      } catch {}
      void refresh().catch(() => {});
    },
  };
}
export type SpacesController = ReturnType<typeof useCollaborationSpaces>;
