import type { NavigationState } from "@codex-web/shared";
import { useEffect, useState } from "react";

/** One metadata stream for all projects; independent of the open chat/history stream. */
export function useNavigation() {
  const [state, setState] = useState<NavigationState>({ threads: [], projects: [] });
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    let stopped = false,
      socket: WebSocket | undefined,
      retry: ReturnType<typeof setTimeout> | undefined,
      attempt = 0;
    let usageRevision = "";
    const connect = () => {
      clearTimeout(retry);
      if (
        stopped ||
        document.visibilityState === "hidden" ||
        socket?.readyState === 0 ||
        socket?.readyState === 1
      )
        return;
      const ws = new WebSocket(
        `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/navigation/events`,
      );
      socket = ws;
      ws.onmessage = ({ data }) => {
        if (stopped || socket !== ws) return;
        try {
          const value = JSON.parse(data) as NavigationState;
          if (!Array.isArray(value.threads) || !Array.isArray(value.projects)) return;
          const revision = JSON.stringify(
            (value as NavigationState & { usageRevision?: Record<string, number> }).usageRevision ??
              {},
          );
          if (revision !== usageRevision) {
            usageRevision = revision;
            window.dispatchEvent(new Event("codex-usage-changed"));
          }
          setState(value);
          setConnected(true);
          attempt = 0;
        } catch {
          /* A reconnect supplies an authoritative snapshot. */
        }
      };
      ws.onclose = () => {
        if (stopped || socket !== ws) return;
        socket = undefined;
        setConnected(false);
        if (document.visibilityState !== "hidden")
          retry = setTimeout(connect, Math.min(15000, 750 * 2 ** Math.min(attempt++, 5)));
      };
      ws.onerror = () => ws.close();
    };
    const visibility = () => {
      if (document.visibilityState === "hidden") {
        clearTimeout(retry);
        socket?.close();
        setConnected(false);
      } else connect();
    };
    connect();
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("online", connect);
    window.addEventListener("pageshow", connect);
    return () => {
      stopped = true;
      clearTimeout(retry);
      socket?.close();
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("online", connect);
      window.removeEventListener("pageshow", connect);
    };
  }, []);
  return { state, connected };
}
