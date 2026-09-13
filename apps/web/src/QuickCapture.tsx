import {
  type NotebookScope,
  notebookScopeSchema,
  type QuickCaptureDraft,
  type QuickCaptureInput,
  type QuickCaptureReceipt,
  quickCaptureDraftSchema,
  quickCaptureSchema,
  type TaskProjectsPage,
} from "@codex-web/shared";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { accountLocalStorage as localStorage } from "./accountStorage.ts";
import { ApiError, api, messageOf } from "./api";
import { Icon } from "./icons";
import "./quick-capture.css";

const draftSchema = quickCaptureDraftSchema;
type Draft = QuickCaptureDraft;
const key = (s: NotebookScope) => (s ? `${s.client}:${s.projectId}` : "global");
function initial(scope: NotebookScope): Draft {
  try {
    const old = draftSchema.safeParse(
      JSON.parse(localStorage.getItem("quick-capture-draft") ?? "null"),
    );
    if (old.success) return old.data;
    if (!scope) {
      const last = notebookScopeSchema.safeParse(
        JSON.parse(localStorage.getItem("quick-capture-default") ?? "null"),
      );
      if (last.success) scope = last.data;
    }
  } catch {}
  return {
    id: crypto.randomUUID(),
    submitted: false,
    input: { kind: "note", scope, text: "", title: "", priority: 1, dueAt: null },
  };
}
export default function QuickCapture({
  scope,
  onClose,
}: {
  scope: NotebookScope;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(() => initial(scope)),
    [projects, setProjects] = useState<TaskProjectsPage>({ items: [], nextOffset: null }),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [saved, setSaved] = useState<QuickCaptureReceipt | null>(null);
  const dialog = useRef<HTMLDialogElement>(null),
    alive = useRef(true),
    saving = useRef(false);
  useEffect(() => {
    alive.current = true;
    let active = true;
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    dialog.current?.focus({ preventScroll: true });
    void api<TaskProjectsPage>("/workspace/projects")
      .then((v) => {
        if (active) setProjects(v);
      })
      .catch((e) => {
        if (active) setError(messageOf(e));
      });
    return () => {
      active = false;
      alive.current = false;
      dialog.current?.close();
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  const persist = (d: Draft) => {
    try {
      localStorage.setItem("quick-capture-draft", JSON.stringify(d));
      return true;
    } catch {
      setError("Не удалось сохранить черновик на устройстве. Текст остаётся открыт.");
      return false;
    }
  };
  const update = (v: Partial<QuickCaptureInput>) => {
    const next = { ...draft, input: { ...draft.input, ...v } };
    setDraft(next);
    persist(next);
  };
  const options = new Map(projects.items.map((p) => [key(p.scope), p]));
  if (draft.input.scope && !options.has(key(draft.input.scope)))
    options.set(key(draft.input.scope), { scope: draft.input.scope, availability: "unknown" });
  const save = async () => {
    if (saving.current) return;
    const parsed = quickCaptureSchema.safeParse(draft.input);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Проверь запись");
      return;
    }
    const pending = { ...draft, input: parsed.data, submitted: true };
    if (!persist(pending)) return;
    setDraft(pending);
    setError("");
    setBusy(true);
    saving.current = true;
    try {
      const result = await api<QuickCaptureReceipt>(`/workspace/captures/${draft.id}`, {
        method: "PUT",
        body: pending.input,
      });
      // A closed/logout dialog leaves the durable pending identity for an explicit retry.
      if (!alive.current) return;
      try {
        const current = JSON.parse(localStorage.getItem("quick-capture-draft") ?? "null");
        if (current?.id === pending.id) localStorage.removeItem("quick-capture-draft");
        localStorage.setItem("quick-capture-default", JSON.stringify(result.scope));
      } catch {}
      window.dispatchEvent(new Event("workspace-change"));
      if (alive.current) setSaved(result);
    } catch (e) {
      if (alive.current) {
        if (
          e instanceof ApiError &&
          (e.status === 400 || ["NOTES_LIMIT", "TASKS_LIMIT"].includes(e.code))
        ) {
          const editable = { ...pending, submitted: false };
          setDraft(editable);
          persist(editable);
        }
        setError(messageOf(e));
      }
    } finally {
      saving.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const openSaved = () => {
    if (!saved) return;
    onClose();
    window.dispatchEvent(
      new CustomEvent("open-captured-record", {
        detail: {
          mode: saved.kind === "task" ? "tasks" : "notes",
          itemId: saved.id,
          scope: saved.scope,
        },
      }),
    );
  };
  return createPortal(
    <dialog
      ref={dialog}
      className="quick-capture-dialog"
      aria-label="Быстрая запись"
      tabIndex={-1}
      onCancel={onClose}
    >
      <header>
        <Icon name="note-edit" />
        <h2>Быстрая запись</h2>
        <button type="button" className="icon-button" aria-label="Закрыть запись" onClick={onClose}>
          <Icon name="close" />
        </button>
      </header>
      <div className="quick-capture-content">
        {saved ? (
          <div className="quick-capture-saved">
            <Icon name="check" size={28} />
            <h3>
              {saved.availability === "missing"
                ? "Запись уже была сохранена и удалена"
                : "Сохранено"}
            </h3>
            <p>{saved.title}</p>
            <div>
              {saved.availability === "available" && (
                <button type="button" className="secondary" onClick={openSaved}>
                  Открыть {saved.kind === "task" ? "задачу" : "заметку"}
                </button>
              )}
              <button type="button" className="primary" onClick={onClose}>
                Готово
              </button>
            </div>
          </div>
        ) : (
          <>
            <fieldset className="quick-capture-kind" aria-label="Тип записи">
              {(["note", "task"] as const).map((kind) => (
                <button
                  type="button"
                  key={kind}
                  aria-pressed={draft.input.kind === kind}
                  disabled={draft.submitted}
                  onClick={() => update({ kind })}
                >
                  <Icon name={kind === "task" ? "check" : "file"} size={17} />
                  {kind === "task" ? "Задача" : "Заметка"}
                </button>
              ))}
            </fieldset>
            <select
              aria-label="Проект записи"
              value={key(draft.input.scope)}
              disabled={draft.submitted}
              onChange={(e) => update({ scope: options.get(e.target.value)?.scope ?? null })}
            >
              <option value="global">Без проекта</option>
              {[...options].map(([id, p]) => (
                <option key={id} value={id}>
                  {p.scope.name} · {p.scope.client === "gpt" ? "GPT" : "Codex"}
                  {p.availability === "archived"
                    ? " · архив"
                    : p.availability === "missing"
                      ? " · недоступен"
                      : ""}
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
                    const p = await api<TaskProjectsPage>(
                      `/workspace/projects?offset=${projects.nextOffset}`,
                    );
                    if (alive.current)
                      setProjects((old) => ({
                        items: [...old.items, ...p.items],
                        nextOffset: p.nextOffset,
                      }));
                  } catch (e) {
                    if (alive.current) setError(messageOf(e));
                  }
                }}
              >
                Ещё проекты
              </button>
            )}
            <textarea
              aria-label="Текст записи"
              placeholder="Что сохранить?"
              value={draft.input.text}
              maxLength={65536}
              rows={6}
              disabled={draft.submitted}
              onChange={(e) => update({ text: e.target.value })}
            />
            {draft.input.kind === "task" && (
              <details className="quick-capture-options">
                <summary>Приоритет и срок</summary>
                <div className="quick-task-fields">
                  <label>
                    Приоритет
                    <select
                      aria-label="Приоритет записи"
                      disabled={draft.submitted}
                      value={draft.input.priority}
                      onChange={(e) => update({ priority: Number(e.target.value) })}
                    >
                      <option value={0}>Низкий</option>
                      <option value={1}>Обычный</option>
                      <option value={2}>Высокий</option>
                    </select>
                  </label>
                  <label>
                    Срок
                    <input
                      type="date"
                      aria-label="Срок записи"
                      disabled={draft.submitted}
                      value={draft.input.dueAt ?? ""}
                      onChange={(e) => update({ dueAt: e.target.value || null })}
                    />
                  </label>
                </div>
              </details>
            )}
            {error && (
              <p className="notice" role="alert">
                {error}
              </p>
            )}
            <footer>
              <button type="button" className="secondary" onClick={onClose}>
                Закрыть
              </button>
              <button
                type="button"
                className="primary"
                disabled={busy || !draft.input.text.trim()}
                onClick={() => void save()}
              >
                {busy ? <span className="spinner" /> : <Icon name="check" size={18} />}
                {busy ? "Сохраняю…" : draft.submitted ? "Проверить сохранение" : "Сохранить"}
              </button>
            </footer>
          </>
        )}
      </div>
    </dialog>,
    document.body,
  );
}
