import type { GuiPreviewAction, GuiPreviewOperation } from "@codex-web/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { accountLocalStorage as localStorage, workspaceMediaUrl } from "./accountStorage.ts";
import { api, messageOf } from "./api";
import type { GuiPreviewTarget } from "./GuiPreviewHost";
import { Icon } from "./icons";
import "./project-delivery.css";
import "./gui-preview.css";

type Catalog = {
  installed: boolean;
  actions: GuiPreviewAction[];
  threadId: string | null;
  operations: GuiPreviewOperation[];
};
type Pending = { id: string; actionId: string; threadId: string };
const labels = {
  queued: "В очереди",
  launching: "Запускаем приложение",
  waiting: "Ждём окно",
  captured: "Снимок готов",
  failed: "Не получилось",
  unknown: "Проверяем состояние",
};
export default function GuiPreviewPanel({
  target,
  onClose,
}: {
  target: GuiPreviewTarget;
  onClose: () => void;
}) {
  const [data, setData] = useState<Catalog>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [revision, setRevision] = useState(0),
    [stop, setStop] = useState<string>();
  const dialog = useRef<HTMLDialogElement>(null),
    alive = useRef(true),
    base = `/projects/${encodeURIComponent(target.projectId)}/gui-previews`,
    storage = `gui-preview-pending:${target.projectId}`;
  const [pending, setPending] = useState<Pending | undefined>(() => {
    try {
      const v = JSON.parse(localStorage.getItem(storage) ?? "null");
      if (v && [v.id, v.actionId, v.threadId].every((x) => typeof x === "string")) return v;
    } catch {}
    return undefined;
  });
  const update = useCallback(
    (op: GuiPreviewOperation) =>
      setData((old) =>
        old
          ? {
              ...old,
              operations: [op, ...old.operations.filter((v) => v.id !== op.id)]
                .sort((a, b) => b.createdAt - a.createdAt)
                .slice(0, 10),
            }
          : old,
      ),
    [],
  );
  useEffect(() => {
    alive.current = true;
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    dialog.current?.focus({ preventScroll: true });
    return () => {
      alive.current = false;
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Explicit refresh revalidates the captured project.
  useEffect(() => {
    let active = true;
    setError("");
    void api<Catalog>(base)
      .then((v) => {
        if (active) setData({ ...v, threadId: target.threadId ?? v.threadId });
      })
      .catch((e) => {
        if (active) setError(messageOf(e));
      });
    return () => {
      active = false;
    };
  }, [base, revision, target.threadId]);
  useEffect(() => {
    let active = true,
      running = false;
    const timer = setInterval(async () => {
      if (running || document.hidden) return;
      const ops =
        data?.operations
          .filter(
            (v) => v.appOpen || (!v.resultId && v.state !== "failed" && v.expiresAt > Date.now()),
          )
          .slice(0, 2) ?? [];
      running = true;
      try {
        for (const op of ops) {
          const next = await api<GuiPreviewOperation>(base + "/" + op.id);
          if (active) update(next);
        }
      } catch {
      } finally {
        running = false;
      }
    }, 2500);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [base, data, update]);
  const send = async (p: Pending) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      localStorage.setItem(storage, JSON.stringify(p));
      setPending(p);
      const op = await api<GuiPreviewOperation>(base + "/" + p.id, {
        method: "PUT",
        body: { actionId: p.actionId, threadId: p.threadId },
      });
      if (!alive.current) return;
      update(op);
      setPending(undefined);
      localStorage.removeItem(storage);
    } catch (e) {
      if (alive.current) setError(messageOf(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const closeApp = async (id: string) => {
    setBusy(true);
    setError("");
    try {
      const op = await api<GuiPreviewOperation>(base + "/" + id + "/stop", {
        method: "POST",
        body: { confirm: true },
      });
      if (alive.current) {
        update(op);
        setStop(undefined);
      }
    } catch (e) {
      if (alive.current) setError(messageOf(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const remote = () => {
    onClose();
    window.dispatchEvent(
      new CustomEvent("open-preview-remote", { detail: { projectId: target.projectId } }),
    );
  };
  const view = (op: GuiPreviewOperation) => {
    onClose();
    window.dispatchEvent(
      new CustomEvent("open-delivery-target", {
        detail: {
          client: "codex",
          kind: "result",
          projectId: op.projectId,
          threadId: op.threadId,
          id: op.resultId,
          label: op.label,
        },
      }),
    );
  };
  return (
    <dialog
      ref={dialog}
      tabIndex={-1}
      className="delivery-dialog gui-preview-dialog"
      aria-label="Предпросмотр приложения"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <header>
        <div>
          <small>{target.projectName}</small>
          <h2>
            <Icon name="image" />
            Предпросмотр
          </h2>
        </div>
        <div>
          <button
            type="button"
            className="icon-button"
            aria-label="Обновить предпросмотры"
            disabled={busy}
            onClick={() => setRevision((n) => n + 1)}
          >
            <Icon name="refresh" />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Закрыть предпросмотр"
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </div>
      </header>
      <div className="delivery-scroll">
        {error && (
          <p role="alert" className="delivery-error">
            {error}
          </p>
        )}
        {!data && !error && (
          <p role="status">
            <span className="spinner" />
            Проверяем доступные действия…
          </p>
        )}
        {data && !data.actions.length && (
          <p>
            {data.installed
              ? "Для этого проекта пока нет настроенного приложения."
              : "На компьютере пока не настроен предпросмотр приложений."}
          </p>
        )}
        {data && data.actions.length > 0 && !data.threadId && (
          <p>Сначала открой или создай чат этого проекта.</p>
        )}
        {pending && (
          <section className="gui-preview-item">
            <p>Запрос сохранён. Проверить его отправку?</p>
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => void send(pending)}
            >
              Проверить запрос
            </button>
          </section>
        )}
        <div className="gui-preview-actions">
          {data?.actions.map((action) => (
            <button
              type="button"
              className="primary"
              key={action.id}
              disabled={
                busy ||
                !!pending ||
                !data.threadId ||
                data.operations.some(
                  (op) =>
                    op.actionId === action.id &&
                    (op.appOpen ||
                      ["queued", "launching", "waiting", "unknown"].includes(op.state)) &&
                    op.expiresAt > Date.now(),
                )
              }
              onClick={() =>
                void send({
                  id: crypto.randomUUID(),
                  actionId: action.id,
                  threadId: data.threadId!,
                })
              }
            >
              <Icon name="play" size={17} />
              {action.label}
              {action.capture === "desktop-crop" && <small>Область рабочего стола</small>}
            </button>
          ))}
        </div>
        {data?.operations.map((op) => (
          <section className="gui-preview-item" key={op.id} aria-label={op.label}>
            <div className="gui-preview-heading">
              <strong>{op.label}</strong>
              <span role="status">
                {["queued", "launching", "waiting"].includes(op.state) && (
                  <span className="spinner" />
                )}
                {labels[op.state]}
              </span>
            </div>
            {op.error && <p className="delivery-error">{op.error}</p>}
            {op.artifact && op.resultId && (
              <button
                type="button"
                className="gui-preview-image"
                aria-label="Открыть снимок в результатах"
                onClick={() => view(op)}
              >
                <img src={workspaceMediaUrl(op.artifact.url)} alt={op.label} />
              </button>
            )}
            {op.capture === "desktop-crop" && <small>Снимок области рабочего стола</small>}
            <div className="gui-preview-actions">
              {op.appOpen && (
                <>
                  <button type="button" className="secondary" onClick={remote}>
                    <Icon name="remote" size={17} />
                    Remote
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() => setStop(op.id)}
                  >
                    Закрыть приложение
                  </button>
                </>
              )}
              {op.state === "unknown" && (
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => {
                    void api<GuiPreviewOperation>(base + "/" + op.id)
                      .then((v) => {
                        if (alive.current) update(v);
                      })
                      .catch((e) => {
                        if (alive.current) setError(messageOf(e));
                      });
                  }}
                >
                  Проверить
                </button>
              )}
            </div>
            {stop === op.id && (
              <div className="gui-preview-confirm">
                <p>
                  Закрыть «{op.label}»? Несохранённые изменения в этом предпросмотре будут потеряны.
                </p>
                <div className="gui-preview-actions">
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() => setStop(undefined)}
                  >
                    Отмена
                  </button>
                  <button
                    type="button"
                    className="danger"
                    disabled={busy}
                    onClick={() => void closeApp(op.id)}
                  >
                    Закрыть приложение
                  </button>
                </div>
              </div>
            )}
          </section>
        ))}
      </div>
    </dialog>
  );
}
