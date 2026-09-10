import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api, messageOf } from "./api";
import { Icon } from "./icons";
import type { Attachment } from "./types";

interface QueuedMessage {
  id: string;
  text: string;
  revision: string;
  state: string;
  attachments: Attachment[];
  otherInputs: number;
}
interface QueueState {
  available: boolean;
  items: QueuedMessage[];
  canSteer: boolean;
  message?: string;
}
export function useMessageQueue(threadId: string) {
  const [state, setState] = useState<QueueState>({ available: false, items: [], canSteer: false });
  const [error, setError] = useState(""),
    [loadError, setLoadError] = useState(""),
    [busy, setBusy] = useState(false);
  const readFailures = useRef(0);
  const current = useRef(threadId);
  current.current = threadId;
  const request = useRef(0),
    pending = useRef<{ signature: string; id: string } | undefined>(undefined);
  const busyRef = useRef(false);
  const refresh = useCallback(async () => {
    if (!threadId) return;
    const seq = ++request.current;
    try {
      const value = await api<QueueState>(`/threads/${threadId}/queue`);
      if (current.current === threadId && seq === request.current) {
        setState(value);
        readFailures.current = 0;
        setLoadError("");
      }
      return value;
    } catch (e) {
      if (current.current === threadId && seq === request.current) {
        if (e instanceof ApiError && e.code === "MACHINE_RELEASED") {
          readFailures.current = 0;
          setLoadError("");
        } else if (++readFailures.current >= 3) {
          setLoadError("Не удалось обновить очередь. Повторяем подключение.");
        }
      }
      throw e;
    }
  }, [threadId]);
  useEffect(() => {
    setState({ available: false, items: [], canSteer: false });
    setError("");
    setLoadError("");
    readFailures.current = 0;
    setBusy(false);
    busyRef.current = false;
    let disposed = false,
      checking = false;
    const check = () => {
      if (disposed || checking || document.visibilityState !== "visible") return;
      checking = true;
      void refresh()
        .catch(() => {})
        .finally(() => {
          checking = false;
        });
    };
    check();
    const timer = setInterval(check, 2500);
    const change = (e: Event) => {
      if ((e as CustomEvent<string>).detail === threadId) check();
    };
    window.addEventListener("codex-queue-changed", change);
    document.addEventListener("visibilitychange", check);
    return () => {
      disposed = true;
      request.current++;
      clearInterval(timer);
      window.removeEventListener("codex-queue-changed", change);
      document.removeEventListener("visibilitychange", check);
    };
  }, [threadId, refresh]);
  const action = async (fn: () => Promise<unknown>, handoff = false) => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    setError("");
    const id = threadId;
    try {
      await fn();
      // A failed read after an acknowledged mutation must not keep a sent draft.
      void refresh().catch(() => {});
      return true;
    } catch (e) {
      if (handoff && e instanceof ApiError && e.code === "MACHINE_RELEASED") throw e;
      if (current.current === id) setError(messageOf(e));
      void refresh().catch(() => {});
      return false;
    } finally {
      if (current.current === id) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  };
  const add = (text: string, attachments: string[]) =>
    action(async () => {
      const signature = JSON.stringify({ threadId, text, attachments });
      if (pending.current?.signature !== signature)
        pending.current = { signature, id: crypto.randomUUID() };
      await api(`/threads/${threadId}/queue`, {
        method: "POST",
        body: { text, attachments, clientId: pending.current.id },
      });
      pending.current = undefined;
    }, true);
  const change = (
    item: QueuedMessage,
    kind: "edit" | "delete" | "steer" | "restore",
    text?: string,
    expectedTurnId?: string,
  ) =>
    action(() =>
      api(`/threads/${threadId}/queue/${encodeURIComponent(item.id)}`, {
        method: "POST",
        key: crypto.randomUUID(),
        body: { revision: item.revision, action: kind, text, expectedTurnId },
      }),
    );
  return { state, error: error || loadError, busy, add, change };
}
export function MessageQueue({
  queue,
  turnId,
}: {
  queue: ReturnType<typeof useMessageQueue>;
  turnId: string | null;
}) {
  const [editRevision, setEditRevision] = useState("");
  const [editing, setEditing] = useState(""),
    [text, setText] = useState("");
  if (!queue.state.items.length && !queue.error) return null;
  return (
    <section className="message-queue" aria-label="Очередь сообщений">
      {!!queue.state.items.length && (
        <div className="queue-heading">
          <span>
            Далее <b>{queue.state.items.length}</b>
          </span>
          <small>После текущего ответа</small>
        </div>
      )}
      {queue.error && (
        <div className="composer-error" role="alert">
          {queue.error}
        </div>
      )}
      <div className="queue-scroll">
        {queue.state.items.map((item) => (
          <article className="queue-item" key={item.id} data-queue-id={item.id}>
            {editing === item.id ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void queue
                    .change({ ...item, revision: editRevision }, "edit", text)
                    .then((ok) => {
                      if (ok) setEditing("");
                    });
                }}
              >
                <textarea
                  aria-label="Изменить сообщение в очереди"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  rows={3}
                  maxLength={32000}
                />
                <div className="queue-actions">
                  <button type="button" className="text-button" onClick={() => setEditing("")}>
                    Отмена
                  </button>
                  <button
                    type="submit"
                    className="text-button"
                    disabled={queue.busy || !text.trim()}
                  >
                    Сохранить
                  </button>
                </div>
              </form>
            ) : (
              <>
                <p className="queue-text">{item.text || "Вложения"}</p>
                {!!item.attachments.length && (
                  <div className="queue-files">
                    {item.attachments.map((f) => (
                      <span key={f.id}>
                        {f.image && <img src={f.previewUrl} alt="" />}
                        {f.name}
                      </span>
                    ))}
                  </div>
                )}
                {!!item.otherInputs && (
                  <small className="muted">Дополнительные вложения: {item.otherInputs}</small>
                )}
                {["unknown", "enqueue_unknown"].includes(item.state) && (
                  <p className="composer-error">
                    Передача сообщения не подтверждена. Проверь последний ответ перед повторной
                    постановкой в очередь.
                  </p>
                )}
                {item.state === "steered" ? (
                  <span className="small muted" role="status">
                    <Icon name="check" size={14} /> Принято
                  </span>
                ) : (
                  <div className="queue-actions">
                    {item.state === "queued" ? (
                      <button
                        type="button"
                        className="text-button steer-button"
                        disabled={queue.busy || !turnId || !queue.state.canSteer}
                        title={
                          queue.state.canSteer
                            ? "Направить текущую работу"
                            : "Текущий ход открыт в другом клиенте"
                        }
                        onClick={() =>
                          void queue.change(item, "steer", undefined, turnId ?? undefined)
                        }
                      >
                        Steer <Icon name="send" size={14} />
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="text-button"
                        disabled={queue.busy || ["pending", "enqueue_pending"].includes(item.state)}
                        onClick={() => void queue.change(item, "restore")}
                      >
                        {["pending", "enqueue_pending"].includes(item.state)
                          ? "Передаём…"
                          : "Вернуть в очередь"}
                      </button>
                    )}
                    <button
                      type="button"
                      className="text-button"
                      disabled={queue.busy || ["pending", "enqueue_pending"].includes(item.state)}
                      onClick={() => {
                        setEditing(item.id);
                        setEditRevision(item.revision);
                        setText(item.text);
                      }}
                      aria-label="Изменить сообщение"
                    >
                      Изменить
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      disabled={queue.busy || ["pending", "enqueue_pending"].includes(item.state)}
                      onClick={() => void queue.change(item, "delete")}
                      aria-label="Удалить сообщение из очереди"
                    >
                      <Icon name="close" size={17} />
                    </button>
                  </div>
                )}
              </>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
