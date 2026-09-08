import type {
  NotebookLink,
  NotebookPin,
  NotebookScope,
  NotebookTarget,
  NoteRecord,
  NotesPage,
  NoteWrite,
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
export type NotebookRequest = { scope: NotebookScope; target?: NotebookTarget };
export type WorkspaceDestination = { target: NotebookLink; version: number };
export const notebookKey = (scope: NotebookScope) =>
  scope ? `${scope.client}:${scope.projectId}` : "global";
export function cleanTarget(t: NotebookTarget): NotebookTarget {
  const { client, kind, id, title, projectId, threadId, turnId } = t;
  return { client, kind, id, title, projectId, threadId, turnId };
}
type Draft = NoteWrite & { id: string; changedAt: number; createdAt?: number; savedAt?: number };
const prefix = "workspace-note-draft:";
const drafts = (): Draft[] => {
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
const payload = (d: NoteWrite): NoteWrite => ({
  scope: d.scope,
  title: d.title,
  body: d.body,
  links: d.links.map(cleanTarget),
  revision: d.revision,
});
export function NotebookPanel({
  request,
  onClose,
  onOpen,
}: {
  request: NotebookRequest | undefined;
  onClose: () => void;
  onOpen: (target: NotebookLink) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    [scope, setScope] = useState("all"),
    [query, setQuery] = useState(""),
    [page, setPage] = useState<NotesPage>({ items: [], nextOffset: null }),
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
      setLocal(drafts());
    } catch {
      setStorageError("Не удалось прочитать черновики на этом устройстве.");
    }
  }, []);
  const keep = (d: Draft) => {
    setEdit(d);
    setDirty(true);
    setStatus("");
    try {
      if (!localStorage.getItem(prefix + d.id) && drafts().length >= 20)
        throw Error("Сохрани или удали один из 20 черновиков, чтобы освободить место.");
      localStorage.setItem(prefix + d.id, JSON.stringify(d));
      setStorageError("");
      refreshDrafts();
    } catch (e) {
      setStorageError(
        e instanceof Error && e.message.startsWith("Сохрани")
          ? e.message
          : "Браузер не сохранил черновик. Сохрани заметку на сервер или скопируй текст перед закрытием.",
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
        for (const d of drafts()) localStorage.removeItem(prefix + d.id);
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
          `/workspace/notes?scope=${encodeURIComponent(scope)}&q=${encodeURIComponent(query)}`,
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
  }, [request, scope, query, revision]);
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
        cached = drafts().find((d) => d.id === id);
      } catch {
        /* Server notes remain readable without browser storage. */
      }
      if (cached) {
        select(cached, true);
        return;
      }
      const note = await api<NoteRecord>(`/workspace/notes/${id}`);
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
        const value = await api<NoteRecord>(`/workspace/notes/${d.id}`, {
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
          if (e.code === "NOTE_DELETED") setDeleted(true);
          else if (e.code === "NOTE_CONFLICT") {
            try {
              const current = await api<NoteRecord>(`/workspace/notes/${d.id}`);
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
    if (t.kind === "note") {
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
      aria-label="Заметки и ссылки"
      tabIndex={-1}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <header className="notebook-heading">
        <Icon name="file" />
        <strong>Заметки и ссылки</strong>
        <button
          type="button"
          className="icon-button"
          disabled={busy}
          aria-label="Закрыть заметки"
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </header>
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
        <aside className="notebook-list" aria-label="Список заметок">
          <div className="notebook-controls">
            <select
              aria-label="Область заметок"
              value={scope}
              disabled={busy}
              onChange={(e) => setScope(e.target.value)}
            >
              <option value="all">Все заметки</option>
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
              aria-label="Новая заметка"
              onClick={create}
            >
              <Icon name="plus" />
            </button>
          </div>
          <input
            type="search"
            aria-label="Найти заметку"
            placeholder="Найти заметку…"
            maxLength={200}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
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
            <section aria-label="Черновики заметок">
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
            <div className="notebook-row" key={n.id} data-selected={edit?.id === n.id}>
              <button type="button" disabled={busy} onClick={() => void load(n.id)}>
                <b>{n.title}</b>
                <small>{n.excerpt || n.scope?.name || "Общая заметка"}</small>
              </button>
            </div>
          ))}
          {!loading && !page.items.length && !filteredDrafts.length && (
            <p className="muted">Пока нет заметок.</p>
          )}
          {page.nextOffset !== null && (
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() =>
                void operation(async () => {
                  const next = await api<NotesPage>(
                    `/workspace/notes?scope=${encodeURIComponent(scope)}&q=${encodeURIComponent(query)}&offset=${page.nextOffset}`,
                  );
                  setPage((old) => ({
                    items: [...old.items, ...next.items],
                    nextOffset: next.nextOffset,
                  }));
                })
              }
            >
              Ещё заметки
            </button>
          )}
        </aside>
        <section className="notebook-editor" aria-label="Редактор заметки">
          {!edit ? (
            <div className="notebook-empty">
              <Icon name="file" size={40} />
              <p>Идеи, решения и контекст проектов.</p>
              <button type="button" className="primary" onClick={create}>
                Создать заметку
              </button>
            </div>
          ) : (
            <>
              <div className="notebook-editor-tools">
                <button
                  type="button"
                  className="icon-button notebook-back"
                  disabled={busy}
                  aria-label="К списку заметок"
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
                  aria-label="Проект заметки"
                  disabled={busy}
                  value={notebookKey(edit.scope)}
                  onChange={(e) => change({ scope: scopes.get(e.target.value) ?? null })}
                >
                  {[...scopes].map(([key, s]) => (
                    <option key={key} value={key}>
                      {s ? s.name : "Общая заметка"}
                    </option>
                  ))}
                </select>
                <CopyButton text={edit.body} label="Копировать заметку" />
                <button
                  type="button"
                  className="icon-button"
                  disabled={busy || !edit.revision}
                  aria-label="Закрепить заметку"
                  onClick={() =>
                    void pin(
                      {
                        client: edit.scope?.client ?? "codex",
                        kind: "note",
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
                aria-label="Название заметки"
                placeholder="Название"
                maxLength={120}
                value={edit.title}
                disabled={busy}
                onChange={(e) => change({ title: e.target.value })}
              />
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
                    {edit.body || "*Пустая заметка*"}
                  </Markdown>
                </div>
              ) : (
                <textarea
                  className="notebook-body"
                  aria-label="Текст заметки"
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
                    Удалить {edit.revision ? "заметку" : "черновик"} «{edit.title || "Без названия"}
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
                          await api(`/workspace/notes/${id}`, {
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
                    aria-label="Удалить заметку"
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
