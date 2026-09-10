import type { NotebookScope, NoteCapture, NoteRecord, TaskProjectsPage } from "@codex-web/shared";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, messageOf } from "./api";
import { Icon } from "./icons";

export function CaptureNote({ capture, onClose }: { capture: NoteCapture; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [id] = useState(() => crypto.randomUUID());
  const [scope, setScope] = useState<NotebookScope>(capture.scope);
  const [projects, setProjects] = useState<TaskProjectsPage>({ items: [], nextOffset: null });
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    const abort = new AbortController();
    dialog.current?.showModal();
    dialog.current?.focus({ preventScroll: true });
    void api<TaskProjectsPage>("/workspace/projects", { signal: abort.signal })
      .then(setProjects)
      .catch((e) => {
        if (!abort.signal.aborted) setError(messageOf(e));
      });
    return () => {
      abort.abort();
      dialog.current?.close();
    };
  }, []);
  const key = (s: NotebookScope) => (s ? `${s.client}:${s.projectId}` : "global");
  const options = new Map(projects.items.map((p) => [key(p.scope), p.scope]));
  if (capture.scope && !options.has(key(capture.scope)))
    options.set(key(capture.scope), capture.scope);
  const save = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await api<NoteRecord>(`/workspace/notes/${id}/capture`, {
        method: "PUT",
        body: { ...capture, scope },
      });
      window.dispatchEvent(new Event("workspace-change"));
      onClose();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };
  return createPortal(
    <dialog
      ref={dialog}
      className="notebook-dialog note-capture-dialog"
      tabIndex={-1}
      aria-label="Сохранить в заметки"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <header className="notebook-heading">
        <Icon name="file" />
        <strong>В заметки</strong>
        <button
          type="button"
          className="icon-button"
          aria-label="Закрыть сохранение"
          disabled={busy}
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </header>
      <div className="note-capture-content">
        <select
          aria-label="Проект заметки"
          value={key(scope)}
          disabled={busy}
          onChange={(e) => setScope(options.get(e.target.value) ?? null)}
        >
          <option value="global">Без проекта</option>
          {[...options].map(([k, s]) => (
            <option key={k} value={k}>
              {s.name} · {s.client === "gpt" ? "GPT" : "Codex"}
            </option>
          ))}
        </select>
        {projects.nextOffset !== null && (
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={async () => {
              try {
                const next = await api<TaskProjectsPage>(
                  `/workspace/projects?offset=${projects.nextOffset}`,
                );
                setProjects((old) => ({
                  items: [...old.items, ...next.items],
                  nextOffset: next.nextOffset,
                }));
              } catch (e) {
                setError(messageOf(e));
              }
            }}
          >
            Ещё проекты
          </button>
        )}
        <blockquote>{capture.text}</blockquote>
        <small className="muted">
          {capture.target.client === "gpt" ? "GPT" : "Codex"} ·{" "}
          {capture.role === "user" ? "Вы" : "Ответ"}
        </small>
        {error && (
          <p role="alert" className="notice">
            {error}
          </p>
        )}
        <footer className="notebook-save">
          <button type="button" className="secondary" disabled={busy} onClick={onClose}>
            Отмена
          </button>
          <button type="button" className="primary" disabled={busy} onClick={() => void save()}>
            {busy ? <span className="spinner" /> : <Icon name="check" />} Сохранить
          </button>
        </footer>
      </div>
    </dialog>,
    document.body,
  );
}
