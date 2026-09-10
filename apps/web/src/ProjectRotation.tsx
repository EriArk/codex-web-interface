import type { NotebookLink, ProjectAction, ProjectScope } from "@codex-web/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, messageOf } from "./api";
import { Icon } from "./icons";
import { ProjectActionPanel } from "./ProjectAction";
import "./project-work.css";
export function ProjectRotation({
  scope,
  onClose,
  onOpen,
  onChanged,
}: {
  scope: ProjectScope;
  onClose: () => void;
  onOpen: (target: NotebookLink) => void;
  onChanged: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    mounted = useRef(true),
    bound = useRef("");
  const [action, setAction] = useState<ProjectAction | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [revision, setRevision] = useState(0);
  const key = `workspace-rotation:${scope.client}:${scope.projectId}`;
  useEffect(() => {
    mounted.current = true;
    dialog.current?.showModal();
    dialog.current?.focus({ preventScroll: true });
    return () => {
      mounted.current = false;
      dialog.current?.close();
    };
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Explicit retry prepares a fresh review only when no action can have been submitted.
  useEffect(() => {
    const abort = new AbortController();
    setBusy(true);
    setError("");
    const prepare = async () => {
      let id: string = crypto.randomUUID();
      try {
        id = sessionStorage.getItem(key) || id;
        sessionStorage.setItem(key, id);
      } catch {}
      let value = await api<ProjectAction>("/workspace/actions/" + id, {
        method: "PUT",
        body: { scope, kind: "rotate" },
        signal: abort.signal,
      });
      if (["completed", "cancelled", "failed"].includes(value.state)) {
        id = crypto.randomUUID();
        try {
          sessionStorage.setItem(key, id);
        } catch {}
        value = await api<ProjectAction>("/workspace/actions/" + id, {
          method: "PUT",
          body: { scope, kind: "rotate" },
          signal: abort.signal,
        });
      }
      if (!abort.signal.aborted) setAction(value);
    };
    void prepare()
      .catch((e) => {
        if (!abort.signal.aborted) setError(messageOf(e));
      })
      .finally(() => {
        if (!abort.signal.aborted) setBusy(false);
      });
    return () => abort.abort();
  }, [key, revision]);
  const changed = useCallback(
    (value: ProjectAction) => {
      if (mounted.current) {
        setAction(value);
        if (value.snapshot.stage === "bound" && bound.current !== value.id) {
          bound.current = value.id;
          onChanged();
        }
      }
    },
    [onChanged],
  );
  const reset = async () => {
    if (!action || busy) return;
    setBusy(true);
    setError("");
    try {
      await api("/workspace/actions/" + action.id + "/cancel", {
        method: "POST",
        body: { confirm: true },
      });
      sessionStorage.removeItem(key);
      setAction(null);
      setRevision((n) => n + 1);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };
  return createPortal(
    <dialog
      ref={dialog}
      className="rotation-dialog"
      aria-label="Новый рабочий чат"
      tabIndex={-1}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <header className="notebook-heading">
        <Icon name="history" />
        <strong>Новый рабочий чат</strong>
        <button
          type="button"
          className="icon-button"
          aria-label="Закрыть переход"
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </header>
      <div className="rotation-content">
        <p>
          Основа проекта и краткий контекст перейдут в новый чат. Предыдущий останется в истории.
        </p>
        {error && (
          <p role="alert" className="notice">
            {error}
          </p>
        )}
        {busy && !action && (
          <p role="status">
            <span className="spinner" /> Подготавливаю контекст…
          </p>
        )}
        {action && (
          <ProjectActionPanel
            key={action.id}
            initial={action}
            onChange={changed}
            onOpen={(target) => {
              onClose();
              onOpen(target);
            }}
            showTitle={false}
          />
        )}
        {action?.state === "blocked" &&
          ["ROTATION_CONTEXT_CHANGED", "PROJECT_CHAT_CHANGED"].includes(action.errorCode ?? "") && (
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => void reset()}
            >
              Обновить контекст
            </button>
          )}
        {!action && !busy && error && (
          <button type="button" className="secondary" onClick={() => setRevision((n) => n + 1)}>
            Повторить подготовку
          </button>
        )}
      </div>
    </dialog>,
    document.body,
  );
}
