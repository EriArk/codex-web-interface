import type {
  NotebookLink,
  NotebookPin,
  NotebookScope,
  NotebookTarget,
  NoteRecord,
  NoteSummary,
  NotesPage,
  NoteWrite,
  TaskFields,
} from "@codex-web/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ApiError, api, messageOf } from "./api";
import { CollapsibleCode } from "./CollapsibleCode";
import { CopyButton } from "./CopyButton";
import { Icon } from "./icons";
import { PinnedList } from "./PinnedList";
import "./notebook.css";
export type NotebookRequest = {
  scope: NotebookScope;
  target?: NotebookTarget;
  mode?: "notes" | "tasks";
  itemId?: string;
};
export type WorkspaceDestination = { target: NotebookLink; version: number };
export const notebookKey = (scope: NotebookScope) =>
  scope ? `${scope.client}:${scope.projectId}` : "global";
export function cleanTarget(t: NotebookTarget): NotebookTarget {
  const { client, kind, id, title, projectId, threadId, turnId } = t;
  return { client, kind, id, title, projectId, threadId, turnId };
}
type Draft = NoteWrite &
  Partial<TaskFields> & { id: string; changedAt: number; createdAt?: number; savedAt?: number };
const drafts = (prefix: string): Draft[] => {
  const rows: Draft[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key?.startsWith(prefix)) continue;
    try {
      const d = JSON.parse(localStorage.getItem(key) ?? "");
      if (
        typeof d.id === "string" &&
        typeof d.title === "string" &&
        typeof d.body === "string" &&
        Array.isArray(d.links) &&
        Number.isInteger(d.revision)
      )
        rows.push(d);
    } catch {}
  }
  return rows.sort((a, b) => b.changedAt - a.changedAt);
};
export function NotebookPanel({
  request,
  onClose,
  onOpen,
  onRequest,
}: {
  request: NotebookRequest | undefined;
  onClose: () => void;
  onOpen: (target: NotebookLink) => void;
  onRequest: (request: NotebookRequest) => void;
}) {
  const isTask = request?.mode === "tasks",
    base = `/workspace/${isTask ? "tasks" : "notes"}`,
    prefix = isTask ? "workspace-task-draft:" : "workspace-note-draft:";
  const labels = {
    title: isTask ? "План" : "Заметки и ссылки",
    item: isTask ? "задача" : "заметка",
    plural: isTask ? "задачи" : "заметки",
    genitive: isTask ? "задач" : "заметок",
  };
  const [filter, setFilter] = useState("open");
  const today = new Date(),
    day = [
      today.getFullYear(),
      String(today.getMonth() + 1).padStart(2, "0"),
      String(today.getDate()).padStart(2, "0"),
    ].join("-");
  const taskQuery = isTask ? `&filter=${filter}&today=${day}` : "";
  const payload = (d: NoteWrite & Partial<TaskFields>): NoteWrite & Partial<TaskFields> => ({
    scope: d.scope,
    title: d.title,
    body: d.body,
    links: d.links.map(cleanTarget),
    revision: d.revision,
    ...(isTask
      ? { status: d.status ?? "todo", priority: d.priority ?? 1, dueAt: d.dueAt ?? null }
      : {}),
  });
  const dialog = useRef<HTMLDialogElement>(null),
    [scope, setScope] = useState("all"),
    [query, setQuery] = useState(""),
    [page, setPage] = useState<{
      items: (NoteSummary & Partial<TaskFields>)[];
      nextOffset: number | null;
    }>({ items: [], nextOffset: null }),
    [pins, setPins] = useState<{ items: NotebookPin[]; nextOffset: number | null }>({
      items: [],
      nextOffset: null,
    }),
    [local, setLocal] = useState<Draft[]>([]),
    [edit, setEdit] = useState<Draft | null>(null),
    [dirty, setDirty] = useState(false),
    [preview, setPreview] = useState(false),
    [error, setError] = useState(""),
    [storageError, setStorageError] = useState(""),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(false),
    [revision, setRevision] = useState(0),
    [conflict, setConflict] = useState<NoteRecord | null>(null),
    [deleted, setDeleted] = useState(false),
    [confirmDelete, setConfirmDelete] = useState(false),
    [status, setStatus] = useState("");
  const editRef = useRef(edit);
  editRef.current = edit;
  const generation = useRef(0),
    active = useRef(false);
  active.current = !!request;
  const refreshDrafts = useCallback(() => {
    try {
      setLocal(drafts(prefix));
    } catch {
      setStorageError("Не удалось прочитать черновики на этом устройстве.");
    }
  }, [prefix]);
  const keep = (d: Draft) => {
    setEdit(d);
    setDirty(true);
    setStatus("");
    try {
      if (!localStorage.getItem(prefix + d.id) && drafts(prefix).length >= 20)
        throw Error("Сохрани или удали один из 20 черновиков, чтобы освободить место.");
      localStorage.setItem(prefix + d.id, JSON.stringify(d));
      setStorageError("");
      refreshDrafts();
    } catch (e) {
      setStorageError(
        e instanceof Error && e.message.startsWith("Сохрани")
          ? e.message
          : "Браузер не сохранил черновик. Сохрани на сервер или скопируй текст перед закрытием.",
      );
    }
  };
  const forget = (id: string, expected?: Draft) => {
    try {
      if (expected) {
        const current = localStorage.getItem(prefix + id);
        if (current && current !== JSON.stringify(expected)) {
          refreshDrafts();
          return;
        }
      }
      localStorage.removeItem(prefix + id);
      refreshDrafts();
    } catch {
      setStorageError("Не удалось убрать сохранённый черновик.");
    }
  };
  const select = (d: Draft, isDirty: boolean) => {
    generation.current++;
    setEdit(d);
    setDirty(isDirty);
    setConflict(null);
    setDeleted(false);
    setConfirmDelete(false);
    setPreview(false);
    setError("");
    setStatus("");
  };
  useEffect(() => {
    const clear = () => {
      try {
        for (const key of ["workspace-note-draft:", "workspace-task-draft:"])
          for (const d of drafts(key)) localStorage.removeItem(key + d.id);
      } catch {}
      setEdit(null);
      setLocal([]);
    };
    window.addEventListener("private-session-ended", clear);
    return () => window.removeEventListener("private-session-ended", clear);
  }, []);
  // Opening a panel restores local drafts, never a native conversation or writer.
  useEffect(() => {
    if (!request) return;
    generation.current++;
    setBusy(false);
    setEdit(null);
    setScope(notebookKey(request.scope));
    setQuery("");
    setFilter("open");
    setError("");
    setStatus("");
    refreshDrafts();
    dialog.current?.showModal();
    dialog.current?.focus({ preventScroll: true });
    return () => {
      generation.current++;
      dialog.current?.close();
    };
  }, [request, refreshDrafts]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Explicit refresh polls only small Hub metadata.
  useEffect(() => {
    if (!request) return;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    const timer = setTimeout(() => {
      void Promise.all([
        api<NotesPage>(
          `${base}?scope=${encodeURIComponent(scope)}&q=${encodeURIComponent(query)}${taskQuery}`,
          { signal: controller.signal },
        ),
        api<typeof pins>(`/workspace/pins?scope=${encodeURIComponent(scope)}`, {
          signal: controller.signal,
        }),
      ])
        .then(([notes, saved]) => {
          if (!controller.signal.aborted) {
            setPage(notes);
            setPins(saved);
          }
        })
        .catch((e) => {
          if (!controller.signal.aborted) setError(messageOf(e));
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 150);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [request, scope, query, revision, base, taskQuery]);
  useEffect(() => {
    if (!request) return;
    const refresh = () => {
      if (!document.hidden) {
        refreshDrafts();
        setRevision((v) => v + 1);
      }
    };
    const timer = setInterval(refresh, 30000);
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("online", refresh);
    };
  }, [request, refreshDrafts]);
  const operation = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    const g = generation.current;
    try {
      await fn();
    } catch (e) {
      if (active.current && g === generation.current) setError(messageOf(e));
    } finally {
      if (active.current && g === generation.current) setBusy(false);
    }
  };
  const load = async (id: string) => {
    setError("");
    const g = ++generation.current;
    setLoading(true);
    try {
      let cached: Draft | undefined;
      try {
        cached = drafts(prefix).find((d) => d.id === id);
      } catch {
        /* Server notes remain readable without browser storage. */
      }
      if (cached) {
        select(cached, true);
        return;
      }
      const note = await api<NoteRecord>(`${base}/${id}`);
      if (g === generation.current && active.current)
        select(
          {
            ...payload(note),
            id: note.id,
            createdAt: note.createdAt,
            savedAt: note.updatedAt,
            changedAt: note.updatedAt,
          },
          false,
        );
    } catch (e) {
      if (g === generation.current && active.current) setError(messageOf(e));
    } finally {
      if (active.current) setLoading(false);
    }
  };
  const create = () => {
    const d: Draft = {
      id: crypto.randomUUID(),
      revision: 0,
      scope: scope === "global" || scope === "all" ? null : (scopes.get(scope) ?? null),
      title: "",
      body: "",
      links: request?.target ? [cleanTarget(request.target)] : [],
      changedAt: Date.now(),
      ...(isTask ? { status: "todo" as const, priority: 1, dueAt: null } : {}),
    };
    select(d, true);
    keep(d);
  };
  const save = async (overwrite?: number, asNew = false) => {
    if (!edit) return;
    const d = {
      ...edit,
      id: asNew ? crypto.randomUUID() : edit.id,
      revision: asNew ? 0 : (overwrite ?? edit.revision),
    };
    const g = generation.current;
    // Preserve the exact submission before sending. Retry uses the same UUID and content.
    keep(d);
    if (asNew) {
      setConflict(null);
      setDeleted(false);
    }
    await operation(async () => {
      try {
        const value = await api<NoteRecord>(`${base}/${d.id}`, {
          method: "PUT",
          body: payload(d),
        });
        forget(d.id, d);
        if (asNew) forget(edit.id, edit);
        if (!active.current || g !== generation.current) return;
        setEdit({
          ...payload(value),
          id: value.id,
          createdAt: value.createdAt,
          savedAt: value.updatedAt,
          changedAt: value.updatedAt,
        });
        setDirty(false);
        setConflict(null);
        setDeleted(false);
        setStatus("Сохранено");
        setRevision((v) => v + 1);
      } catch (e) {
        if (
          active.current &&
          g === generation.current &&
          e instanceof ApiError &&
          e.status === 409
        ) {
          setError(e.message);
          if (e.code === "NOTE_DELETED" || e.code === "TASK_DELETED") setDeleted(true);
          else if (e.code === "NOTE_CONFLICT" || e.code === "TASK_CONFLICT") {
            try {
              const current = await api<NoteRecord>(`${base}/${d.id}`);
              if (g === generation.current) setConflict(current);
            } catch (readError) {
              if (g === generation.current) {
                if (readError instanceof ApiError && readError.status === 404) setDeleted(true);
                else setError(messageOf(readError));
              }
            }
          }
        } else throw e;
      }
    });
  };
  const pin = async (target: NotebookTarget, pinScope: NotebookScope, value = true) =>
    operation(async () => {
      await api("/workspace/pins", {
        method: "PUT",
        body: { scope: pinScope, target: cleanTarget(target), value },
      });
      if (active.current) {
        setStatus(value ? "Ссылка сохранена" : "Ссылка убрана");
        setRevision((v) => v + 1);
      }
    });
  const open = async (t: NotebookTarget) => {
    if (t.kind === (isTask ? "task" : "note")) {
      await load(t.id);
      return;
    }
    await operation(async () => {
      const target = await api<NotebookLink>("/workspace/resolve", {
        method: "POST",
        body: cleanTarget(t),
      });
      if (!active.current) return;
      if (target.availability === "missing")
        throw Error("Источник удалён или недоступен. Ссылка остаётся в заметках.");
      onOpen(target);
    });
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: An explicit bookmarked item is opened once per panel request.
  useEffect(() => {
    if (request?.itemId) void load(request.itemId);
  }, [request]);
  const changeStatus = (n: NoteSummary & Partial<TaskFields>) =>
    operation(async () => {
      await api(`${base}/${n.id}/status`, {
        method: "PATCH",
        body: { revision: n.revision, status: n.status === "done" ? "todo" : "done" },
      });
      setRevision((v) => v + 1);
      if (edit?.id === n.id && !dirty) {
        const value = await api<NoteRecord>(`${base}/${n.id}`);
        setEdit({
          ...payload(value),
          id: value.id,
          changedAt: value.updatedAt,
          createdAt: value.createdAt,
          savedAt: value.updatedAt,
        });
      }
    });
  if (!request) return null;
  const scopes = new Map<string, NotebookScope>([["global", null]]);
  if (request.scope) scopes.set(notebookKey(request.scope), request.scope);
  for (const n of [...page.items, ...local, ...pins.items])
    if (n.scope) scopes.set(notebookKey(n.scope), n.scope);
  if (edit?.scope) scopes.set(notebookKey(edit.scope), edit.scope);
  const change = (next: Partial<Draft>) => {
    if (edit) keep({ ...edit, ...next, changedAt: Date.now() });
  };
  const filteredDrafts = local.filter(
    (d) =>
      (scope === "all" || notebookKey(d.scope) === scope) &&
      (!query || `${d.title} ${d.body}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())),
  );
  return createPortal(
    <dialog
      ref={dialog}
      className="notebook-dialog"
      aria-label={labels.title}
      tabIndex={-1}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <header className="notebook-heading">
        <Icon name="file" />
        <strong>{labels.title}</strong>
        <button
          type="button"
          className="icon-button"
          disabled={busy}
          aria-label={isTask ? "Закрыть план" : "Закрыть заметки"}
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </header>
      <div className="notebook-modules">
        <button
          type="button"
          aria-pressed={!isTask}
          disabled={busy}
          onClick={() => onRequest({ ...request, mode: "notes", itemId: undefined })}
        >
          Заметки
        </button>
        <button
          type="button"
          aria-pressed={isTask}
          disabled={busy}
          onClick={() => onRequest({ ...request, mode: "tasks", itemId: undefined })}
        >
          План
        </button>
      </div>
      {(error || storageError) && (
        <div className="notice" role="alert">
          {error}
          {storageError && <p>{storageError}</p>}
        </div>
      )}
      {status && (
        <p className="notebook-status" role="status">
          {status}
        </p>
      )}
      <div className="notebook-layout" data-editing={!!edit}>
        <aside className="notebook-list" aria-label={isTask ? "Список задач" : "Список заметок"}>
          <div className="notebook-controls">
            <select
              aria-label={isTask ? "Область задач" : "Область заметок"}
              value={scope}
              disabled={busy}
              onChange={(e) => setScope(e.target.value)}
            >
              <option value="all">{isTask ? "Все проекты" : "Все заметки"}</option>
              {[...scopes].map(([key, s]) => (
                <option key={key} value={key}>
                  {s ? `${s.name} · ${s.client === "gpt" ? "GPT" : "Codex"}` : "Общие"}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="icon-button"
              disabled={busy}
              aria-label={isTask ? "Новая задача" : "Новая заметка"}
              onClick={create}
            >
              <Icon name="plus" />
            </button>
          </div>
          <input
            type="search"
            aria-label={isTask ? "Найти задачу" : "Найти заметку"}
            placeholder={isTask ? "Найти задачу…" : "Найти заметку…"}
            maxLength={200}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {isTask && (
            <select
              className="task-filter"
              aria-label="Состояние задач"
              value={filter}
              disabled={busy}
              onChange={(e) => setFilter(e.target.value)}
            >
              <option value="open">Открытые</option>
              <option value="today">На сегодня</option>
              <option value="doing">В работе</option>
              <option value="blocked">Заблокировано</option>
              <option value="done">Выполнено</option>
              <option value="all">Все</option>
            </select>
          )}
          {request.target && (
            <button
              type="button"
              className="secondary notebook-context"
              disabled={busy}
              onClick={() => void pin(request.target!, request.scope)}
            >
              <Icon name="results" />
              Сохранить ссылку: {request.target.title}
            </button>
          )}
          <PinnedList
            items={pins.items}
            active={() => false}
            recent={(p) => p.createdAt}
            storageKey={`notebook:${scope}`}
            renderItem={(p) => (
              <div className="notebook-pin" key={p.id}>
                <button
                  type="button"
                  disabled={busy || p.target.availability === "missing"}
                  onClick={() => void open(p.target)}
                >
                  {p.target.title}
                  {p.target.availability === "missing" && <small>Источник недоступен</small>}
                </button>
                <button
                  type="button"
                  className="icon-button"
                  disabled={busy}
                  aria-label={`Убрать ссылку: ${p.target.title}`}
                  onClick={() => void pin(p.target, p.scope, false)}
                >
                  <Icon name="close" size={16} />
                </button>
              </div>
            )}
          />
          {pins.nextOffset !== null && (
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() =>
                void operation(async () => {
                  const next = await api<typeof pins>(
                    `/workspace/pins?scope=${encodeURIComponent(scope)}&offset=${pins.nextOffset}`,
                  );
                  setPins((old) => ({
                    items: [...old.items, ...next.items],
                    nextOffset: next.nextOffset,
                  }));
                })
              }
            >
              Ещё ссылки
            </button>
          )}
          {filteredDrafts.length > 0 && (
            <section aria-label={isTask ? "Черновики задач" : "Черновики заметок"}>
              <h3>Черновики</h3>
              {filteredDrafts.map((d) => (
                <div className="notebook-row" key={d.id}>
                  <button type="button" disabled={busy} onClick={() => select(d, true)}>
                    {d.title || "Без названия"}
                    <small>На этом устройстве</small>
                  </button>
                </div>
              ))}
            </section>
          )}
          {loading && (
            <p role="status">
              <span className="spinner" /> Загружаю…
            </p>
          )}
          {page.items.map((n) => (
            <div
              className="notebook-row"
              key={n.id}
              data-selected={edit?.id === n.id}
              data-task={isTask}
            >
              {isTask && (
                <button
                  type="button"
                  className="icon-button task-complete"
                  aria-label={`${n.status === "done" ? "Вернуть в работу" : "Завершить"}: ${n.title}`}
                  disabled={busy || (edit?.id === n.id && dirty)}
                  onClick={() => void changeStatus(n)}
                >
                  {n.status === "done" ? <Icon name="check" /> : <span className="task-circle" />}
                </button>
              )}
              <button type="button" disabled={busy} onClick={() => void load(n.id)}>
                <b>{n.title}</b>
                {isTask && (
                  <span className="task-meta">
                    {n.status === "doing"
                      ? "В работе"
                      : n.status === "blocked"
                        ? "Заблокировано"
                        : n.status === "done"
                          ? "Выполнено"
                          : "Открыта"}
                    {n.priority === 2 ? " · Важно" : ""}
                    {n.dueAt ? ` · ${n.dueAt}` : ""}
                  </span>
                )}
                <small>
                  {n.excerpt || n.scope?.name || (isTask ? "Общая задача" : "Общая заметка")}
                </small>
              </button>
            </div>
          ))}
          {!loading && !page.items.length && !filteredDrafts.length && (
            <p className="muted">
              {isTask ? "Задач в этом списке пока нет." : "Пока нет заметок."}
            </p>
          )}
          {page.nextOffset !== null && (
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() =>
                void operation(async () => {
                  const next = await api<NotesPage>(
                    `${base}?scope=${encodeURIComponent(scope)}&q=${encodeURIComponent(query)}&offset=${page.nextOffset}${taskQuery}`,
                  );
                  setPage((old) => ({
                    items: [...old.items, ...next.items],
                    nextOffset: next.nextOffset,
                  }));
                })
              }
            >
              {isTask ? "Ещё задачи" : "Ещё заметки"}
            </button>
          )}
        </aside>
        <section
          className="notebook-editor"
          aria-label={isTask ? "Редактор задачи" : "Редактор заметки"}
        >
          {!edit ? (
            <div className="notebook-empty">
              <Icon name="file" size={40} />
              <p>{isTask ? "Что нужно сделать дальше?" : "Идеи, решения и контекст проектов."}</p>
              <button type="button" className="primary" onClick={create}>
                {isTask ? "Создать задачу" : "Создать заметку"}
              </button>
            </div>
          ) : (
            <>
              <div className="notebook-editor-tools">
                <button
                  type="button"
                  className="icon-button notebook-back"
                  disabled={busy}
                  aria-label={isTask ? "К списку задач" : "К списку заметок"}
                  onClick={() => {
                    generation.current++;
                    setEdit(null);
                    setConflict(null);
                    setConfirmDelete(false);
                    setError("");
                  }}
                >
                  <Icon name="back" />
                </button>
                <select
                  aria-label={isTask ? "Проект задачи" : "Проект заметки"}
                  disabled={busy}
                  value={notebookKey(edit.scope)}
                  onChange={(e) => change({ scope: scopes.get(e.target.value) ?? null })}
                >
                  {[...scopes].map(([key, s]) => (
                    <option key={key} value={key}>
                      {s ? s.name : isTask ? "Общая задача" : "Общая заметка"}
                    </option>
                  ))}
                </select>
                <CopyButton
                  text={edit.body}
                  label={isTask ? "Копировать задачу" : "Копировать заметку"}
                />
                <button
                  type="button"
                  className="icon-button"
                  disabled={busy || !edit.revision}
                  aria-label={isTask ? "Закрепить задачу" : "Закрепить заметку"}
                  onClick={() =>
                    void pin(
                      {
                        client: edit.scope?.client ?? "codex",
                        kind: isTask ? "task" : "note",
                        id: edit.id,
                        title: edit.title,
                      },
                      edit.scope,
                    )
                  }
                >
                  <Icon name="pin" />
                </button>
              </div>
              <input
                className="notebook-title"
                aria-label={isTask ? "Название задачи" : "Название заметки"}
                placeholder="Название"
                maxLength={120}
                value={edit.title}
                disabled={busy}
                onChange={(e) => change({ title: e.target.value })}
              />
              {isTask && (
                <div className="task-fields">
                  <label>
                    Статус
                    <select
                      aria-label="Статус задачи"
                      value={edit.status ?? "todo"}
                      disabled={busy}
                      onChange={(e) => change({ status: e.target.value as TaskFields["status"] })}
                    >
                      <option value="todo">Открыта</option>
                      <option value="doing">В работе</option>
                      <option value="blocked">Заблокировано</option>
                      <option value="done">Выполнено</option>
                    </select>
                  </label>
                  <label>
                    Приоритет
                    <select
                      aria-label="Приоритет задачи"
                      value={edit.priority ?? 1}
                      disabled={busy}
                      onChange={(e) => change({ priority: Number(e.target.value) })}
                    >
                      <option value={0}>Низкий</option>
                      <option value={1}>Обычный</option>
                      <option value={2}>Высокий</option>
                    </select>
                  </label>
                  <label>
                    До
                    <input
                      type="date"
                      aria-label="Срок задачи"
                      value={edit.dueAt ?? ""}
                      disabled={busy}
                      onChange={(e) => change({ dueAt: e.target.value || null })}
                    />
                  </label>
                </div>
              )}
              <div className="notebook-mode">
                <button type="button" aria-pressed={!preview} onClick={() => setPreview(false)}>
                  Текст
                </button>
                <button type="button" aria-pressed={preview} onClick={() => setPreview(true)}>
                  Просмотр
                </button>
                <span className="muted">{dirty ? "Черновик" : "Сохранено"}</span>
              </div>
              {preview ? (
                <div className="notebook-markdown">
                  <Markdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      pre: CollapsibleCode,
                      img: ({ alt }) => <span>{alt || "Изображение"}</span>,
                      a: ({ href, children }) => (
                        <a href={href} target="_blank" rel="noopener noreferrer">
                          {children}
                        </a>
                      ),
                    }}
                  >
                    {edit.body || (isTask ? "*Без описания*" : "*Пустая заметка*")}
                  </Markdown>
                </div>
              ) : (
                <textarea
                  className="notebook-body"
                  aria-label={isTask ? "Описание задачи" : "Текст заметки"}
                  placeholder="Запиши важное…"
                  maxLength={65536}
                  value={edit.body}
                  disabled={busy}
                  onChange={(e) => change({ body: e.target.value })}
                />
              )}
              <div className="notebook-links">
                {edit.links.map((link, i) => (
                  <div key={`${link.kind}:${link.id}`}>
                    <button type="button" disabled={busy} onClick={() => void open(link)}>
                      <Icon name="chevron" size={14} />
                      {link.title}
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      disabled={busy}
                      aria-label={`Убрать из заметки: ${link.title}`}
                      onClick={() => change({ links: edit.links.filter((_, n) => n !== i) })}
                    >
                      <Icon name="close" size={14} />
                    </button>
                  </div>
                ))}
                {request.target &&
                  edit.links.length < 8 &&
                  !edit.links.some(
                    (t) => t.id === request.target?.id && t.kind === request.target.kind,
                  ) && (
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy}
                      onClick={() =>
                        change({ links: [...edit.links, cleanTarget(request.target!)] })
                      }
                    >
                      Добавить ссылку: {request.target.title}
                    </button>
                  )}
              </div>
              {conflict && (
                <div className="notice notebook-conflict" role="alert">
                  <p>На сервере есть другая версия.</p>
                  <details>
                    <summary>Посмотреть версию с другого устройства</summary>
                    <strong>{conflict.title}</strong>
                    <pre>{conflict.body}</pre>
                  </details>
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() => void save(conflict.revision)}
                  >
                    Сохранить мой вариант
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() => void save(undefined, true)}
                  >
                    Сохранить как новую
                  </button>
                </div>
              )}
              {deleted && (
                <button
                  type="button"
                  className="primary"
                  disabled={busy}
                  onClick={() => void save(undefined, true)}
                >
                  Сохранить как новую
                </button>
              )}
              {confirmDelete ? (
                <div className="notice" role="alert">
                  <p>
                    Удалить {edit.revision ? (isTask ? "задачу" : "заметку") : "черновик"} «
                    {edit.title || "Без названия"}
                    »?
                  </p>
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() => setConfirmDelete(false)}
                  >
                    Отмена
                  </button>
                  <button
                    type="button"
                    className="danger"
                    disabled={busy}
                    onClick={() =>
                      void operation(async () => {
                        const id = edit.id;
                        if (edit.revision)
                          await api(`${base}/${id}`, {
                            method: "DELETE",
                            body: { revision: edit.revision, confirm: true },
                          });
                        forget(id);
                        setEdit(null);
                        setConfirmDelete(false);
                        setRevision((v) => v + 1);
                      })
                    }
                  >
                    Удалить
                  </button>
                </div>
              ) : (
                <footer className="notebook-save">
                  <button
                    type="button"
                    className="icon-button danger"
                    disabled={busy}
                    aria-label={isTask ? "Удалить задачу" : "Удалить заметку"}
                    onClick={() => setConfirmDelete(true)}
                  >
                    <Icon name="trash" />
                  </button>
                  {edit.savedAt && (
                    <small
                      className="notebook-times"
                      title={`Создана: ${new Date(edit.createdAt ?? edit.savedAt).toLocaleString("ru")}`}
                    >
                      {new Date(edit.savedAt).toLocaleString("ru", {
                        day: "numeric",
                        month: "short",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </small>
                  )}
                  <button
                    type="button"
                    className="primary"
                    disabled={busy || !edit.title.trim() || !!conflict || deleted}
                    onClick={() => void save()}
                  >
                    {busy ? <span className="spinner" /> : <Icon name="check" />}Сохранить
                  </button>
                </footer>
              )}
            </>
          )}
        </section>
      </div>
    </dialog>,
    document.body,
  );
}
