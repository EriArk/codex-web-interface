import type { NativeWork } from "@codex-web/shared";
import { useEffect, useState } from "react";
import { api } from "./api";

export function ContextUsage({ threadId, active }: { threadId: string; active: boolean }) {
  const [usage, setUsage] = useState<NativeWork["usage"]>();
  useEffect(() => {
    setUsage(undefined);
    if (!threadId) return;
    const controller = new AbortController();
    let pending = false;
    const load = async () => {
      if (pending || document.visibilityState === "hidden") return;
      pending = true;
      try {
        const data = await api<{ usage?: NativeWork["usage"] }>(
          `/threads/${encodeURIComponent(threadId)}/context`,
          { signal: controller.signal },
        );
        if (!controller.signal.aborted) setUsage(data.usage);
      } catch {
        /* Optional metrics never block the composer. */
      } finally {
        pending = false;
      }
    };
    void load();
    const timer = setInterval(load, active ? 5000 : 60000);
    document.addEventListener("visibilitychange", load);
    return () => {
      controller.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", load);
    };
  }, [threadId, active]);
  if (!usage) return null;
  const format = (n: number) => n.toLocaleString("ru-RU");
  return (
    <details className="context-usage">
      <summary>
        Контекст: {format(usage.input)}
        {usage.capacity ? ` / ${format(usage.capacity)}` : " токенов"}
      </summary>
      <p>
        Последний запрос: вход {format(usage.input)}, ответ {format(usage.output)}, из кэша{" "}
        {format(usage.cached)}.
      </p>
      {!usage.capacity && <p>Codex не сообщил ёмкость контекста.</p>}
    </details>
  );
}
