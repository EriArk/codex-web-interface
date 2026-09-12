import type { NativeWork } from "@codex-web/shared";
import { useEffect, useState } from "react";
import { api, messageOf } from "./api";
import { CopyButton } from "./CopyButton";
import { LiveCommandOutput } from "./LiveCommandOutput";
import "./turnDetails.css";

interface Detail {
  itemId?: string;
  seq: number;
  kind: string;
  label: string;
  text: string;
}
export function TurnDetails({
  threadId,
  turnId,
  id = "turn-details",
}: {
  threadId: string;
  turnId: string | null;
  id?: string;
}) {
  const [items, setItems] = useState<Detail[]>([]),
    [error, setError] = useState("");
  const [work, setWork] = useState<NativeWork>({ turnId: null });
  useEffect(() => {
    let disposed = false,
      pending = false;
    const controller = new AbortController();
    setItems([]);
    setWork({ turnId: null });
    setError("");
    const refresh = async () => {
      if (disposed || pending || document.visibilityState === "hidden") return;
      pending = true;
      try {
        const value = await api<NativeWork & { items: Detail[] }>(
          `/threads/${threadId}/progress${turnId ? "?turnId=" + encodeURIComponent(turnId) : ""}`,
          { signal: controller.signal },
        );
        if (!disposed) {
          setItems(value.items);
          setWork(value);
          setError("");
        }
      } catch (e) {
        if (!disposed) setError(messageOf(e));
      } finally {
        pending = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 1200);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      disposed = true;
      controller.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [threadId, turnId]);
  return (
    <section id={id} className="turn-details" aria-label="Ход работы">
      {work.plan && (
        <div className="native-plan">
          <strong>Шаги Codex</strong>
          {work.plan.explanation && <p>{work.plan.explanation}</p>}
          <ol>
            {work.plan.steps.map((step, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: Native plan steps have only ordinal identity; progress updates preserve that order.
              <li key={index} data-state={step.status}>
                <span
                  role="img"
                  aria-label={
                    { pending: "Предстоит", inProgress: "В работе", completed: "Готово" }[
                      step.status
                    ]
                  }
                >
                  {step.status === "completed" ? "✓" : step.status === "inProgress" ? "●" : "○"}
                </span>{" "}
                {step.text}
              </li>
            ))}
          </ol>
        </div>
      )}
      {work.diff && (
        <details className="native-diff">
          <summary>Все изменения за ход</summary>
          <pre>{work.diff.text || "Изменений нет"}</pre>
          {work.diff.truncated && <small>Показана первая часть изменений.</small>}
          <CopyButton text={work.diff.text} label="Копировать изменения" />
        </details>
      )}
      {error ? (
        <p role="status">{error}</p>
      ) : !items.length ? (
        <p className="muted">Пока без подробностей</p>
      ) : (
        <ol>
          {items.map((item) => (
            <li key={item.itemId || item.seq}>
              <strong>{item.label}</strong>
              {item.text &&
                (item.kind === "command" ? (
                  <>
                    <details>
                      <summary>Команда</summary>
                      <pre>{item.text}</pre>
                    </details>
                    {item.itemId && (turnId || work.turnId) && (
                      <LiveCommandOutput
                        url={`/api/threads/${encodeURIComponent(threadId)}/commands/${encodeURIComponent(item.itemId)}?turnId=${encodeURIComponent(turnId || work.turnId!)}`}
                      />
                    )}
                  </>
                ) : (
                  <p>{item.text}</p>
                ))}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
