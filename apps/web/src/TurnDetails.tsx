import { useEffect, useState } from "react";
import { api, messageOf } from "./api";
import "./turnDetails.css";

interface Detail {
  seq: number;
  kind: string;
  label: string;
  text: string;
}
export function TurnDetails({ threadId, turnId }: { threadId: string; turnId: string | null }) {
  const [items, setItems] = useState<Detail[]>([]),
    [error, setError] = useState("");
  useEffect(() => {
    let disposed = false,
      pending = false;
    const controller = new AbortController();
    setItems([]);
    setError("");
    const refresh = async () => {
      if (disposed || pending || document.visibilityState === "hidden") return;
      pending = true;
      try {
        const value = await api<{ items: Detail[] }>(
          `/threads/${threadId}/progress${turnId ? "?turnId=" + encodeURIComponent(turnId) : ""}`,
          { signal: controller.signal },
        );
        if (!disposed) {
          setItems(value.items);
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
    <section id="turn-details" className="turn-details" aria-label="Ход работы">
      {error ? (
        <p role="status">{error}</p>
      ) : !items.length ? (
        <p className="muted">Пока без подробностей</p>
      ) : (
        <ol>
          {items.map((item) => (
            <li key={item.seq}>
              <strong>{item.label}</strong>
              {item.text &&
                (item.kind === "command" ? (
                  <details>
                    <summary>Команда</summary>
                    <pre>{item.text}</pre>
                  </details>
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
