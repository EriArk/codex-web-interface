import type { NativePlanAction } from "@codex-web/shared";
import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { Icon } from "./icons";

/** Mounted only beside an actual structured native plan. Never touches the composer. */
export function NativePlan({
  threadId,
  messageId,
  revision,
  visible,
  disabled,
}: {
  threadId: string;
  messageId: string;
  revision: string;
  visible: boolean;
  disabled: boolean;
}) {
  const [action, setAction] = useState<NativePlanAction | null>(null);
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const locked = useRef(false),
    alive = useRef(true);
  const base = `/threads/${encodeURIComponent(threadId)}/native-plan`;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    let active = true;
    if (!visible || !revision) return;
    let pending = false;
    const refresh = async () => {
      if (!active || pending || locked.current || document.hidden) return;
      pending = true;
      try {
        const data = await api<{ action: NativePlanAction | null }>(base);
        if (active) setAction(data.action);
      } catch {
        /* Local action errors remain actionable; background polls do not replace chat. */
      } finally {
        pending = false;
      }
    };
    void refresh();
    const timer = setInterval(refresh, 7000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      active = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [base, revision, visible]);
  const run = async (check = false) => {
    if (locked.current || !action) return;
    locked.current = true;
    setWorking(true);
    setError("");
    try {
      const data = await api<{ action: NativePlanAction | null }>(base + (check ? "/check" : ""), {
        method: "POST",
        body: check ? {} : { revision: action.revision },
      });
      if (alive.current) setAction(data.action);
    } catch (e) {
      if (alive.current) {
        setError(e instanceof Error ? e.message : "Не удалось проверить запуск.");
        try {
          const data = await api<{ action: NativePlanAction | null }>(base);
          if (alive.current) setAction(data.action);
        } catch {}
      }
    } finally {
      locked.current = false;
      if (alive.current) setWorking(false);
    }
  };
  if (!action || action.threadId !== threadId || action.messageId !== messageId) return null;
  return (
    <section className="native-plan-action" aria-label="Реализация нативного плана">
      {action.state === "ready" ? (
        <button
          type="button"
          className="result-chip"
          disabled={working || disabled}
          onClick={() => void run()}
        >
          <Icon name="plan" size={17} />
          {working ? "Запускаем…" : "Реализовать этот план"}
        </button>
      ) : (
        <p role="status">{action.message}</p>
      )}
      {action.state === "unknown" && (
        <button
          type="button"
          className="result-chip"
          disabled={working}
          onClick={() => void run(true)}
        >
          <Icon name="refresh" size={17} />
          {working ? "Проверяем…" : "Проверить запуск"}
        </button>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
