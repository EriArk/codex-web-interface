import type { UsageLimitsData } from "@codex-web/shared";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { api, messageOf } from "./api";
import type { Machine } from "./types";

const empty: UsageLimitsData = { available: false, groups: [], resetCredits: null, checkedAt: "" };
type Snapshot = { data: UsageLimitsData; message: string };
const initial: Snapshot = { data: empty, message: "Загружаю лимиты…" };
const Context = createContext<{
  snapshots: Record<string, Snapshot>;
  refresh: (machineId: string) => Promise<void>;
} | null>(null);

/** One settings-owned read/poll path, shared by the overview and Connections. */
export function UsageLimitsProvider({
  machines,
  open,
  children,
}: {
  machines: Machine[];
  open: boolean;
  children: ReactNode;
}) {
  const [snapshots, setSnapshots] = useState<Record<string, Snapshot>>({});
  const requests = useRef(new Map<string, AbortController>());
  const active = useRef(new Set<string>());
  const machineIds = JSON.stringify(machines.map((m) => m.id).sort());
  const refresh = useCallback(async (machineId: string) => {
    if (!active.current.has(machineId) || document.visibilityState === "hidden") return;
    requests.current.get(machineId)?.abort();
    const controller = new AbortController();
    requests.current.set(machineId, controller);
    try {
      const data = await api<UsageLimitsData>(`/machines/${encodeURIComponent(machineId)}/limits`, {
        signal: controller.signal,
      });
      if (!controller.signal.aborted && active.current.has(machineId))
        setSnapshots((old) => ({
          ...old,
          [machineId]: { data, message: data.available ? "" : "Данные пока недоступны." },
        }));
    } catch (e) {
      if (!controller.signal.aborted && active.current.has(machineId))
        setSnapshots((old) => ({
          ...old,
          [machineId]: { data: old[machineId]?.data ?? empty, message: messageOf(e) },
        }));
    } finally {
      if (requests.current.get(machineId) === controller) requests.current.delete(machineId);
    }
  }, []);
  useEffect(() => {
    const ids: string[] = JSON.parse(machineIds);
    active.current = new Set(open ? ids : []);
    setSnapshots((old) =>
      Object.fromEntries(Object.entries(old).filter(([id]) => ids.includes(id))),
    );
    if (!open) return;
    const changed = () => {
      for (const id of ids) void refresh(id);
    };
    changed();
    const timer = setInterval(changed, 60000);
    document.addEventListener("visibilitychange", changed);
    window.addEventListener("codex-usage-changed", changed);
    return () => {
      active.current.clear();
      for (const controller of requests.current.values()) controller.abort();
      requests.current.clear();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", changed);
      window.removeEventListener("codex-usage-changed", changed);
    };
  }, [machineIds, open, refresh]);
  return <Context.Provider value={{ snapshots, refresh }}>{children}</Context.Provider>;
}

export function useUsageLimits(machineId: string) {
  const context = useContext(Context);
  if (!context) throw new Error("UsageLimits requires its settings provider");
  const { refresh } = context;
  const read = useCallback(() => refresh(machineId), [refresh, machineId]);
  return { ...(context.snapshots[machineId] ?? initial), refresh: read };
}
