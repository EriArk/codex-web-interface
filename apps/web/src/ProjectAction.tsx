import type { ProjectAction as Action, NotebookLink } from "@codex-web/shared";
import { useEffect, useState } from "react";
import { api, messageOf } from "./api";
import { CopyButton } from "./CopyButton";
import { Icon } from "./icons";
import { useWebHandoff } from "./WebHandoff";
export const actionLabels: Record<Action["state"], string> = {
  prepared: "Готово к запуску",
  dispatching: "Отправляю",
  queued: "В очереди",
  running: "В работе",
  completed: "Ответ готов",
  blocked: "Не отправлено",
  unknown: "Проверь состояние",
  failed: "Завершилось с ошибкой",
  cancelled: "Отменено",
};
export function ProjectActionPanel({
  initial,
  onChange,
  onOpen,
  onClose,
}: {
  initial: Action;
  onChange: (value: Action) => void;
  onOpen: (target: NotebookLink) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initial),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const handoff = useWebHandoff(
    typeof value.snapshot.machineId === "string" ? value.snapshot.machineId : undefined,
    value.threadId ?? value.id,
  );
  useEffect(() => {
    setValue(initial);
  }, [initial]);
  useEffect(() => {
    if (!["dispatching", "queued", "running", "unknown"].includes(value.state)) return;
    const abort = new AbortController();
    let pending = false;
    const refresh = async () => {
      if (document.hidden || pending) return;
      pending = true;
      try {
        const next = await api<Action>(`/workspace/actions/${value.id}`, { signal: abort.signal });
        if (!abort.signal.aborted) {
          setValue(next);
          onChange(next);
        }
      } catch {
      } finally {
        pending = false;
      }
    };
    const timer = setInterval(refresh, 3000);
    void refresh();
    return () => {
      abort.abort();
      clearInterval(timer);
    };
  }, [value.id, value.state, onChange]);
  const read = async () => {
    const next = await api<Action>(`/workspace/actions/${value.id}`);
    setValue(next);
    onChange(next);
    return next;
  };
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    await handoff.run(async () => {
      const next = await api<Action>(`/workspace/actions/${value.id}/submit`, {
        method: "POST",
        body: { confirm: true },
      });
      setValue(next);
      onChange(next);
      return true;
    });
    await read().catch((e) => setError(messageOf(e)));
    setBusy(false);
  };
  const source =
    value.source ??
    (value.threadId
      ? {
          client: value.scope.client,
          kind: "thread" as const,
          id: value.threadId,
          threadId: value.threadId,
          projectId: value.scope.projectId,
          title: value.title,
        }
      : null);
  return (
    <>
      <section className="project-action" aria-label="Задание проекта" data-state={value.state}>
        <header>
          <span>
            {["dispatching", "queued", "running"].includes(value.state) ? (
              <span className="spinner" />
            ) : (
              <Icon name={value.state === "completed" ? "check" : "plan"} />
            )}
            <strong>{actionLabels[value.state]}</strong>
          </span>
          <button
            type="button"
            className="icon-button"
            disabled={busy || handoff.pending}
            aria-label="Закрыть задание"
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </header>
        <h3>{value.title}</h3>
        <p className="project-action-meta">
          {value.scope.client === "codex"
            ? `Codex · ${value.settings?.model ?? ""} · Работа`
            : `GPT · ${value.gptSettings?.model ?? ""}`}
        </p>
        <details>
          <summary>
            Текст задания <CopyButton text={value.text} label="Копировать задание" />
          </summary>
          <pre>{value.text}</pre>
        </details>
        {(error || value.error) && (
          <p className="notice" role="alert">
            {error || value.error}
          </p>
        )}
        <div className="project-action-buttons">
          {["prepared", "blocked"].includes(value.state) && (
            <button
              type="button"
              className="primary"
              disabled={busy || handoff.pending}
              onClick={() => void submit()}
            >
              {busy ? <span className="spinner" /> : <Icon name="play" />}
              {value.state === "prepared" ? "Подтвердить и запустить" : "Повторить отправку"}
            </button>
          )}
          {value.state === "prepared" && (
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const next = await api<Action>(`/workspace/actions/${value.id}/cancel`, {
                    method: "POST",
                    body: { confirm: true },
                  });
                  setValue(next);
                  onChange(next);
                } catch (e) {
                  setError(messageOf(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Отмена
            </button>
          )}
          {value.state === "unknown" && (
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => void read().catch((e) => setError(messageOf(e)))}
            >
              Проверить состояние
            </button>
          )}
          {source && value.state !== "prepared" && (
            <button
              type="button"
              className="secondary"
              onClick={() => onOpen({ ...source, availability: "unknown" })}
            >
              Открыть выполнение <Icon name="chevron" size={16} />
            </button>
          )}
        </div>
      </section>
      {handoff.panel}
    </>
  );
}
