import type { FileRequest, FileSnapshot } from "@codex-web/shared";
import { useEffect, useRef, useState } from "react";
import { accountLocalStorage as storage } from "./accountStorage";
import { ApiError, api, messageOf } from "./api";
import { Icon } from "./icons";
import { useWorkspaceDialog } from "./useWorkspaceDialog";

export function FileManagerActions({
  projectId,
  capability,
  checkout,
  folder,
  request,
  onConsume,
  onDone,
}: {
  projectId: string;
  capability: string;
  checkout: string;
  folder: string;
  request: string;
  onConsume: () => void;
  onDone: (path?: string, edit?: boolean) => void;
}) {
  const [mode, setMode] = useState<"menu" | "create" | "mkdir" | "move" | "delete" | null>(null),
    [source, setSource] = useState<FileSnapshot | null>(null),
    [name, setName] = useState(""),
    [clipboard, setClipboard] = useState<{ source: FileSnapshot; op: "copy" | "move" } | null>(
      null,
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null),
    pending = useRef<FileRequest | null>(null);
  const active = useRef(true),
    writing = useRef(false);
  const [recovery, setRecovery] = useState(false);
  const storageKey = `file-operation:${projectId}:${checkout}`;
  useEffect(() => {
    active.current = true;
    try {
      pending.current = JSON.parse(storage.getItem(storageKey) ?? "null");
      setRecovery(!!pending.current);
    } catch {}
    return () => {
      active.current = false;
    };
  }, [storageKey]);
  useWorkspaceDialog(dialog, !!mode);
  const url = `/projects/${encodeURIComponent(projectId)}/file-tools`;
  const join = (parent: string, value: string) => (parent ? `${parent}/${value}` : value);
  useEffect(() => {
    if (!request) return;
    const controller = new AbortController();
    setMode("menu");
    setSource(null);
    setError("");
    void api<FileSnapshot>(`${url}?op=stat&path=${encodeURIComponent(request)}`, {
      signal: controller.signal,
    })
      .then((value) => {
        if (!controller.signal.aborted) setSource(value);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(messageOf(e));
      });
    return () => controller.abort();
  }, [request, url]);
  const close = () => {
    if (!busy) {
      setMode(null);
      onConsume();
    }
  };
  const execute = async (body: Omit<FileRequest, "id">) => {
    if (writing.current) return;
    writing.current = true;
    setBusy(true);
    setError("");
    try {
      if (!pending.current) pending.current = { ...body, id: crypto.randomUUID() };
      const operation = pending.current;
      storage.setItem(storageKey, JSON.stringify(operation));
      const result = await api<FileSnapshot>(url, {
        method: "POST",
        body: { ...operation, capability },
      });
      pending.current = null;
      storage.removeItem(storageKey);
      if (!active.current) return;
      setRecovery(false);
      setMode(null);
      onConsume();
      if (operation.op === "move") setClipboard(null);
      onDone(
        operation.op === "delete" || result.kind === "directory" ? undefined : result.path,
        operation.op === "create",
      );
    } catch (e) {
      if (
        e instanceof ApiError &&
        e.status >= 400 &&
        e.status < 500 &&
        !["FILE_UNKNOWN", "FILE_LOCKED", "FILE_SCOPE_CHANGED"].includes(e.code)
      ) {
        pending.current = null;
        storage.removeItem(storageKey);
      }
      if (active.current) {
        setRecovery(!!pending.current);
        setError(messageOf(e));
      }
    } finally {
      writing.current = false;
      if (active.current) setBusy(false);
    }
  };
  return (
    <>
      {recovery && (
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={() => pending.current && void execute(pending.current)}
        >
          Проверить файловую операцию
        </button>
      )}
      <button
        type="button"
        className="secondary"
        disabled={busy || recovery}
        onClick={() => {
          setName("");
          setError("");
          setMode("create");
        }}
      >
        <Icon name="file" size={16} /> Новый файл
      </button>
      <button
        type="button"
        className="secondary"
        disabled={busy || recovery}
        onClick={() => {
          setName("");
          setError("");
          setMode("mkdir");
        }}
      >
        <Icon name="folder" size={16} /> Новая папка
      </button>
      {clipboard && (
        <>
          <button
            type="button"
            className="secondary"
            disabled={busy || recovery}
            onClick={() =>
              void execute({
                op: clipboard.op,
                path: clipboard.source.path,
                fingerprint: clipboard.source.fingerprint,
                target: join(folder, clipboard.source.path.split("/").at(-1)!),
              })
            }
          >
            Вставить «{clipboard.source.path.split("/").at(-1)}»
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Отменить копирование или перенос"
            onClick={() => setClipboard(null)}
          >
            <Icon name="close" />
          </button>
        </>
      )}
      {!mode && error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
      <dialog
        ref={dialog}
        tabIndex={-1}
        className="workspace-window file-action-dialog"
        aria-label="Действия с файлами"
        onCancel={(e) => {
          e.preventDefault();
          e.stopPropagation();
          close();
        }}
      >
        <header className="panel-heading">
          <strong>
            {mode === "create"
              ? "Новый файл"
              : mode === "mkdir"
                ? "Новая папка"
                : (source?.path ?? request)}
          </strong>
          <button
            type="button"
            className="icon-button"
            disabled={busy}
            aria-label="Закрыть действия с файлом"
            onClick={close}
          >
            <Icon name="close" />
          </button>
        </header>
        {recovery && (
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => pending.current && void execute(pending.current)}
          >
            Проверить файловую операцию
          </button>
        )}
        {mode === "menu" && source && !recovery && (
          <div className="file-action-menu">
            <button
              type="button"
              onClick={() => {
                setName(source.path.split("/").at(-1)!);
                setMode("move");
              }}
            >
              Переименовать
            </button>
            <button
              type="button"
              onClick={() => {
                setClipboard({ source, op: "copy" });
                close();
              }}
            >
              Копировать
            </button>
            <button
              type="button"
              onClick={() => {
                setClipboard({ source, op: "move" });
                close();
              }}
            >
              Вырезать
            </button>
            <button type="button" className="danger" onClick={() => setMode("delete")}>
              Удалить
            </button>
          </div>
        )}
        {mode === "menu" && !source && !error && <p role="status">Открываю…</p>}
        {mode === "delete" && source && !recovery && (
          <div>
            <p>
              Удалить «{source.path}»{source.kind === "directory" ? " и всё содержимое папки" : ""}?
            </p>
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={() =>
                void execute({ op: "delete", path: source.path, fingerprint: source.fingerprint })
              }
            >
              Удалить
            </button>
          </div>
        )}
        {!recovery && (mode === "create" || mode === "mkdir" || mode === "move") && (
          <form
            className="space-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (mode === "move" && source)
                void execute({
                  op: "move",
                  path: source.path,
                  fingerprint: source.fingerprint,
                  target: join(source.path.split("/").slice(0, -1).join("/"), name.trim()),
                });
              else if (mode === "create" || mode === "mkdir")
                void execute({
                  op: mode,
                  path: join(folder, name.trim()),
                  ...(mode === "create" ? { text: "" } : {}),
                });
            }}
          >
            <label>
              Имя
              <input
                autoComplete="off"
                aria-label="Имя файла или папки"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                pattern={"[^/\\\\]+"}
              />
            </label>
            <button type="submit" className="primary" disabled={busy || !name.trim()}>
              {mode === "move" ? "Переименовать" : "Создать"}
            </button>
          </form>
        )}
        {error && (
          <p className="notice" role="alert">
            {error}
          </p>
        )}
      </dialog>
    </>
  );
}
