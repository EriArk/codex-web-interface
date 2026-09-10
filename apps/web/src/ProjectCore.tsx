import {
  type ProjectCore as Core,
  type CoreHistoryPage,
  type CoreValue,
  type CoreWrite,
  coreFields,
  coreLabels,
  coreWriteSchema,
  emptyCore,
  type ProjectScope,
} from "@codex-web/shared";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ApiError, api, messageOf } from "./api";
import { Icon } from "./icons";
import type { NotebookRequest } from "./Notebook";
import "./notebook.css";
import "./project-core.css";
export function ProjectCorePanel({
  request,
  onClose,
}: {
  request: NotebookRequest;
  onClose: () => void;
}) {
  const scope = request.scope as ProjectScope,
    key = `workspace-core-draft:${scope.client}:${scope.projectId}`;
  const query = new URLSearchParams({
    client: scope.client,
    projectId: scope.projectId,
  }).toString();
  const dialog = useRef<HTMLDialogElement>(null),
    mounted = useRef(true);
  const [draft, setDraft] = useState<CoreWrite>({ scope, revision: 0, value: { ...emptyCore } }),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [status, setStatus] = useState(""),
    [dirty, setDirty] = useState(false),
    [conflict, setConflict] = useState<Core | null>(null),
    [history, setHistory] = useState<CoreHistoryPage | null>(null),
    [version, setVersion] = useState<Core | null>(null),
    [confirm, setConfirm] = useState(false);
  useEffect(() => {
    mounted.current = true;
    const abort = new AbortController();
    dialog.current?.showModal();
    dialog.current?.focus({ preventScroll: true });
    const local = () => {
      try {
        const raw = localStorage.getItem(key);
        return raw ? coreWriteSchema.parse(JSON.parse(raw)) : null;
      } catch {
        setError("Не удалось прочитать черновик на устройстве.");
        return null;
      }
    };
    const pending = local();
    if (pending) {
      setDraft(pending);
      setDirty(true);
    }
    void api<Core>("/workspace/core?" + query, { signal: abort.signal })
      .then((core) => {
        if (abort.signal.aborted) return;
        if (!pending) setDraft({ scope, revision: core.revision, value: core.value });
        else if (
          core.revision !== pending.revision &&
          JSON.stringify(core.value) !== JSON.stringify(pending.value)
        )
          setConflict(core);
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(messageOf(e));
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => {
      mounted.current = false;
      abort.abort();
      dialog.current?.close();
    };
  }, [key, query, scope]);
  const keep = (next: CoreWrite) => {
    setDraft(next);
    setDirty(true);
    setStatus("");
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      setError("Черновик не удалось сохранить на устройстве. Сохрани изменения перед закрытием.");
    }
  };
  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      if (mounted.current) {
        setError(messageOf(e));
        if (e instanceof ApiError && e.code === "CORE_CONFLICT") {
          try {
            const current = await api<Core>("/workspace/core?" + query);
            if (mounted.current) setConflict(current);
          } catch {}
        }
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const accept = (saved: Core, sent: CoreWrite) => {
    try {
      const raw = localStorage.getItem(key);
      if (raw && JSON.stringify(coreWriteSchema.parse(JSON.parse(raw))) === JSON.stringify(sent))
        localStorage.removeItem(key);
    } catch {}
    if (!mounted.current) return;
    setDraft({ scope, revision: saved.revision, value: saved.value });
    setDirty(false);
    setConflict(null);
    setStatus("Сохранено");
    setHistory(null);
    setVersion(null);
    setConfirm(false);
    window.dispatchEvent(new Event("workspace-change"));
  };
  const save = (revision = draft.revision) =>
    void run(async () => {
      const sent = { ...draft, revision };
      keep(sent);
      const saved = await api<Core>("/workspace/core", { method: "PUT", body: sent });
      accept(saved, sent);
    });
  const openHistory = () =>
    void run(async () => {
      setHistory(await api<CoreHistoryPage>("/workspace/core/history?" + query));
      setVersion(null);
    });
  const values = version?.value ?? draft.value;
  return createPortal(
    <dialog
      ref={dialog}
      className="notebook-dialog core-dialog"
      aria-label="Основа проекта"
      tabIndex={-1}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <header className="notebook-heading">
        <Icon name="folder" />
        <div className="core-heading-title">
          <strong>Основа проекта</strong>
          <small>{scope.name}</small>
        </div>
        <button
          type="button"
          className="icon-button"
          disabled={busy}
          aria-label="История основы проекта"
          onClick={openHistory}
        >
          <Icon name="history" />
        </button>
        <button
          type="button"
          className="icon-button"
          disabled={busy}
          aria-label="Закрыть основу проекта"
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </header>
      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
      <div className="core-layout" data-history={!!history}>
        {history && (
          <aside className="core-history" aria-label="История основы">
            <header>
              <strong>Версии</strong>
              <button
                type="button"
                className="icon-button"
                aria-label="Закрыть историю"
                onClick={() => {
                  setHistory(null);
                  setVersion(null);
                  setConfirm(false);
                }}
              >
                <Icon name="close" />
              </button>
            </header>
            {history.items.map((h) => (
              <button
                type="button"
                className="core-version"
                key={h.revision}
                aria-pressed={version?.revision === h.revision}
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    setVersion(
                      await api<Core>(
                        "/workspace/core/version?" + query + "&revision=" + h.revision,
                      ),
                    );
                    setConfirm(false);
                  })
                }
              >
                <b>Версия {h.revision}</b>
                <time>
                  {new Date(h.createdAt).toLocaleString("ru", {
                    day: "numeric",
                    month: "short",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </time>
              </button>
            ))}
            {!history.items.length && <p className="muted">Пока нет сохранённых версий.</p>}
            {history.nextOffset !== null && (
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const next = await api<CoreHistoryPage>(
                      "/workspace/core/history?" + query + "&offset=" + history.nextOffset,
                    );
                    setHistory({
                      items: [...history.items, ...next.items],
                      nextOffset: next.nextOffset,
                    });
                  })
                }
              >
                Ещё версии
              </button>
            )}
          </aside>
        )}
        <section
          className="core-content"
          aria-label={version ? "Просмотр версии" : "Редактор основы проекта"}
        >
          {loading ? (
            <p role="status">
              <span className="spinner" /> Загружаю…
            </p>
          ) : (
            <>
              <div className="core-status">
                <span>
                  {version
                    ? `Версия ${version.revision}`
                    : dirty
                      ? "Черновик"
                      : draft.revision
                        ? `Версия ${draft.revision}`
                        : "Новая основа"}
                </span>
                {version && (
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => {
                      setVersion(null);
                      setConfirm(false);
                    }}
                  >
                    К текущей версии
                  </button>
                )}
              </div>
              {coreFields.map((field) => (
                <label className="core-field" key={field}>
                  <span>{coreLabels[field]}</span>
                  <textarea
                    aria-label={coreLabels[field]}
                    value={values[field]}
                    placeholder={
                      field === "purpose"
                        ? "Для чего этот проект?"
                        : field === "constraints"
                          ? "Что обязательно сохранить и что не входит в проект…"
                          : ""
                    }
                    rows={3}
                    maxLength={3000}
                    disabled={busy}
                    readOnly={!!version}
                    onChange={(e) =>
                      keep({
                        ...draft,
                        value: { ...draft.value, [field]: e.target.value } as CoreValue,
                      })
                    }
                  />
                </label>
              ))}
            </>
          )}
        </section>
      </div>
      {conflict && (
        <div className="notice core-conflict" role="alert">
          <p>На другом устройстве сохранена версия {conflict.revision}.</p>
          <details>
            <summary>Посмотреть изменения</summary>
            {coreFields.map((k) => (
              <div key={k}>
                <b>{coreLabels[k]}</b>
                <pre>{conflict.value[k]}</pre>
              </div>
            ))}
          </details>
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => save(conflict.revision)}
          >
            Сохранить мой вариант
          </button>
        </div>
      )}
      <footer className="core-footer">
        <span role="status">{status}</span>
        {version ? (
          <>
            {confirm ? (
              <div role="alert">
                <p>Вернуть версию {version.revision}? Текущая основа останется в истории.</p>
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => setConfirm(false)}
                >
                  Отмена
                </button>
                <button
                  type="button"
                  className="primary"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const saved = await api<Core>("/workspace/core/restore", {
                        method: "POST",
                        body: {
                          scope,
                          revision: draft.revision,
                          version: version.revision,
                          confirm: true,
                        },
                      });
                      accept(saved, draft);
                    })
                  }
                >
                  Восстановить
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="primary"
                disabled={busy || dirty || version.revision === draft.revision}
                onClick={() => setConfirm(true)}
              >
                Вернуть эту версию
              </button>
            )}
          </>
        ) : (
          <button
            type="button"
            className="primary"
            disabled={loading || busy || !!conflict}
            onClick={() => save()}
          >
            {busy ? <span className="spinner" /> : <Icon name="check" />} Сохранить
          </button>
        )}
      </footer>
    </dialog>,
    document.body,
  );
}
