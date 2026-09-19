import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ApiError, api, messageOf } from "./api";
import { Icon } from "./icons";
import "./library.css";

export type LibraryEntity = {
  id: string;
  kind: "thread" | "project";
  name: string;
  projectId?: string;
  pinned?: boolean;
  archived?: boolean;
  deleted?: boolean;
};
export type LibraryChange = LibraryEntity & {
  client: "codex" | "gpt";
  action: "pin" | "rename" | "archive" | "delete";
  value?: boolean;
};
export const libraryEvent = "library-changed";
type Action =
  | { action: "pin" | "archive"; value: boolean }
  | { action: "rename"; name: string }
  | { action: "delete"; confirm: true };
export function EntityMenu({
  client,
  entity: ownerEntity,
  relatedThread,
  active = false,
  outbox = false,
  onDone,
  onNewThread,
  newThreadDisabled = false,
}: {
  client: "codex" | "gpt";
  entity: LibraryEntity;
  relatedThread?: LibraryEntity;
  active?: boolean;
  outbox?: boolean;
  onDone?: () => void;
  onNewThread?: () => void;
  newThreadDisabled?: boolean;
}) {
  const [threadEntity, setThreadEntity] = useState<LibraryEntity | null>(null);
  const entity = threadEntity ?? ownerEntity;
  const [page, setPage] = useState<"menu" | "rename" | "delete" | null>(null),
    [name, setName] = useState(entity.name),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [recovery, setRecovery] = useState<{ key: string; action: Action } | null>(null);
  const [checking, setChecking] = useState(false);
  const opened = !!page;
  useEffect(() => {
    if (!opened || client !== "gpt" || outbox) return;
    let valid = true;
    setChecking(true);
    api<{ pending: { key: string; action: Action } | null }>(
      "/library/gpt/" + entity.kind + "/" + encodeURIComponent(entity.id) + "/pending",
    )
      .then((value) => {
        if (valid) setRecovery(value.pending);
      })
      .catch((e) => {
        if (valid) setError(messageOf(e));
      })
      .finally(() => {
        if (valid) setChecking(false);
      });
    return () => {
      valid = false;
    };
  }, [opened, client, outbox, entity.kind, entity.id]);
  const dialog = useRef<HTMLDialogElement>(null),
    attempt = useRef({ body: "", key: "" }),
    titleId = useId();
  useEffect(() => {
    if (page) {
      dialog.current?.showModal();
      if (page === "rename") dialog.current?.querySelector<HTMLInputElement>("input")?.focus();
      else if (page === "delete")
        dialog.current?.querySelector<HTMLButtonElement>(".entity-footer button")?.focus();
    } else dialog.current?.close();
  }, [page]);
  const close = () => {
    if (!busy) setPage(null);
  };
  const submit = async (action: Action) => {
    if (busy || checking) return;
    const body = JSON.stringify(action);
    if (attempt.current.body !== body) attempt.current = { body, key: crypto.randomUUID() };
    setBusy(true);
    setError("");
    try {
      await api(
        outbox
          ? "/gpt/jobs/" + encodeURIComponent(entity.id) + "/dismiss"
          : "/library/" + client + "/" + entity.kind + "/" + encodeURIComponent(entity.id),
        {
          method: "POST",
          body: outbox ? { confirm: true } : action,
          key: attempt.current.key,
        },
      );
      if (!outbox)
        window.dispatchEvent(
          new CustomEvent<LibraryChange>(libraryEvent, {
            detail: {
              ...entity,
              ...action,
              client,
              name: action.action === "rename" ? action.name : entity.name,
            },
          }),
        );
      setPage(null);
      attempt.current = { body: "", key: "" };
      setRecovery(null);
      onDone?.();
    } catch (e) {
      if (e instanceof ApiError && e.code === "GPT_LIBRARY_UNKNOWN")
        setRecovery({ key: attempt.current.key, action });
      if (e instanceof ApiError && e.code === "GPT_ACTION_REJECTED") {
        attempt.current = { body: "", key: "" };
        setRecovery(null);
      }
      setError(
        e instanceof ApiError && (e.status >= 500 || e.code === "INVALID_RESPONSE")
          ? "Сервер не подтвердил действие. Обнови список и проверь результат."
          : messageOf(e),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button
        type="button"
        className="icon-button entity-trigger"
        aria-label={"Действия: " + ownerEntity.name}
        aria-haspopup="dialog"
        onClick={() => {
          setError("");
          setThreadEntity(null);
          setName(ownerEntity.name);
          setPage("menu");
        }}
      >
        <Icon name="more" size={18} />
      </button>
      {page &&
        createPortal(
          <dialog
            ref={dialog}
            className={"entity-dialog " + (page === "menu" ? "entity-menu" : "")}
            aria-labelledby={titleId}
            onCancel={(e) => {
              e.preventDefault();
              close();
            }}
          >
            <div className="entity-heading">
              <h2 id={titleId}>
                {page === "rename"
                  ? "Переименовать"
                  : page === "delete"
                    ? "Удалить " +
                      (outbox ? "отправку?" : entity.kind === "project" ? "проект?" : "чат?")
                    : entity.name}
              </h2>
              <button
                type="button"
                className="icon-button"
                aria-label="Закрыть действия"
                disabled={busy}
                onClick={close}
              >
                <Icon name="close" />
              </button>
            </div>
            {checking ? (
              <p className="entity-status" role="status">
                Проверяем незавершённые действия…
              </p>
            ) : recovery ? (
              <div className="entity-confirm">
                <p>
                  Результат предыдущего действия пока не подтверждён. Проверка не повторяет команду.
                </p>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    attempt.current = { body: JSON.stringify(recovery.action), key: recovery.key };
                    void submit(recovery.action);
                  }}
                >
                  <Icon name="refresh" /> Проверить результат
                </button>
              </div>
            ) : page === "menu" ? (
              <div className="entity-actions">
                {client === "codex" && entity.kind === "project" && onNewThread && (
                  <button
                    type="button"
                    disabled={busy || newThreadDisabled}
                    onClick={() => {
                      setPage(null);
                      onNewThread();
                    }}
                  >
                    <Icon name="plus" />
                    Новый чат
                  </button>
                )}
                {threadEntity ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setThreadEntity(null);
                      setName(ownerEntity.name);
                    }}
                  >
                    <Icon name="back" />К проекту
                  </button>
                ) : client === "codex" && ownerEntity.kind === "project" && relatedThread ? (
                  <button
                    type="button"
                    className="entity-related"
                    disabled={busy}
                    onClick={() => {
                      setThreadEntity(relatedThread);
                      setName(relatedThread.name);
                    }}
                  >
                    <Icon name="chat" />
                    <span>Чат: {relatedThread.name}</span>
                  </button>
                ) : null}
                {!outbox && (
                  <>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void submit({ action: "pin", value: !entity.pinned })}
                    >
                      <Icon name="pin" />
                      {entity.pinned ? "Открепить" : "Закрепить"}
                    </button>
                    <button type="button" disabled={busy} onClick={() => setPage("rename")}>
                      <Icon name="edit" />
                      Переименовать
                    </button>
                    <button
                      type="button"
                      disabled={busy || active}
                      onClick={() => void submit({ action: "archive", value: !entity.archived })}
                    >
                      <Icon name="archive" />
                      {entity.archived ? "Разархивировать" : "Архивировать"}
                    </button>
                  </>
                )}
                <button
                  type="button"
                  className="entity-danger"
                  disabled={busy || active}
                  onClick={() => setPage("delete")}
                >
                  <Icon name="trash" />
                  Удалить
                </button>
              </div>
            ) : page === "rename" ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void submit({ action: "rename", name: name.trim() });
                }}
              >
                <input
                  aria-label="Название"
                  maxLength={120}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={busy}
                />
                <div className="entity-footer">
                  <button type="button" onClick={close} disabled={busy}>
                    Отмена
                  </button>
                  <button type="submit" className="primary" disabled={busy || !name.trim()}>
                    Сохранить
                  </button>
                </div>
              </form>
            ) : (
              <div className="entity-confirm">
                <p className="entity-name">{entity.name}</p>
                <p>
                  {outbox
                    ? "Сохранённая отправка будет удалена. Сообщение не отправится."
                    : entity.kind === "project"
                      ? client === "codex"
                        ? "Проект исчезнет из Codex. Файлы на компьютере сохранятся, чаты останутся без проекта."
                        : "Проект, его чаты и файлы будут удалены из ChatGPT. Восстановить их не получится."
                      : "Чат будет удалён без возможности восстановления."}
                </p>
                <div className="entity-footer">
                  <button type="button" disabled={busy} onClick={close}>
                    Отмена
                  </button>
                  <button
                    type="button"
                    className="entity-delete"
                    disabled={busy}
                    onClick={() => void submit({ action: "delete", confirm: true })}
                  >
                    Удалить
                  </button>
                </div>
              </div>
            )}
            {busy && (
              <div className="entity-status" role="status">
                <span className="spinner" />
                Сохраняем…
              </div>
            )}
            {error && (
              <p role="alert" className="inline-error">
                {error}
              </p>
            )}
          </dialog>,
          document.body,
        )}
    </>
  );
}
export function EntityArchive({ client }: { client: "codex" | "gpt" }) {
  const [open, setOpen] = useState(false),
    [items, setItems] = useState<LibraryEntity[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [next, setNext] = useState<string | number | null>(null),
    [machine, setMachine] = useState(""),
    [machines, setMachines] = useState<{ id: string; name: string }[]>([]);
  const dialog = useRef<HTMLDialogElement>(null),
    titleId = useId(),
    version = useRef(0);
  const load = async (cursor?: string | number, machineId = machine) => {
    const request = ++version.current;
    setBusy(true);
    setError("");
    try {
      const q = new URLSearchParams();
      if (machineId) q.set("machineId", machineId);
      if (cursor !== undefined) q.set(client === "gpt" ? "offset" : "cursor", String(cursor));
      const data = await api<{
        items: LibraryEntity[];
        nextCursor?: string | null;
        nextOffset?: number | null;
        machines?: { id: string; name: string }[];
      }>("/library/" + client + "/archived?" + q);
      if (request !== version.current) return;
      setItems((old) => (cursor === undefined ? data.items : [...old, ...data.items]));
      setNext(data.nextCursor ?? data.nextOffset ?? null);
      if (data.machines) setMachines(data.machines);
    } catch (e) {
      if (request === version.current) setError(messageOf(e));
    } finally {
      if (request === version.current) setBusy(false);
    }
  };
  useEffect(() => {
    if (open) dialog.current?.showModal();
    else dialog.current?.close();
  }, [open]);
  return (
    <>
      <button
        type="button"
        className="nav-new-thread"
        onClick={() => {
          setOpen(true);
          void load();
        }}
      >
        <Icon name="archive" size={18} />
        Архив
      </button>
      {open &&
        createPortal(
          <dialog
            className="entity-dialog archive-dialog"
            ref={dialog}
            aria-labelledby={titleId}
            onCancel={() => setOpen(false)}
          >
            <div className="entity-heading">
              <h2 id={titleId}>Архив</h2>
              <button
                type="button"
                className="icon-button"
                aria-label="Закрыть архив"
                onClick={() => setOpen(false)}
              >
                <Icon name="close" />
              </button>
            </div>
            {machines.length > 1 && (
              <select
                aria-label="Компьютер архива"
                value={machine || machines[0]?.id}
                onChange={(e) => {
                  setMachine(e.target.value);
                  void load(undefined, e.target.value);
                }}
              >
                {machines.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            )}
            <div className="archive-list">
              {items.map((item) => (
                <div className="entity-row" key={item.kind + item.id}>
                  <Icon name={item.kind === "project" ? "folder" : "chat"} size={18} />
                  <span>{item.name}</span>
                  <EntityMenu
                    client={client}
                    entity={{ ...item, archived: true }}
                    onDone={() => void load()}
                  />
                </div>
              ))}
            </div>
            {!busy && !items.length && !error && <p className="nav-empty">Архив пуст</p>}
            {busy && (
              <div className="entity-status" role="status">
                <span className="spinner" />
                Загружаем…
              </div>
            )}
            {error && (
              <p role="alert" className="inline-error">
                {error}
                <button type="button" onClick={() => void load()}>
                  Повторить
                </button>
              </p>
            )}
            {next !== null && (
              <button type="button" disabled={busy} onClick={() => void load(next)}>
                Загрузить ещё
              </button>
            )}
          </dialog>,
          document.body,
        )}
    </>
  );
}
