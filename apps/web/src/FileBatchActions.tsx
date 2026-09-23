import type { FileRequest, FileSnapshot } from "@codex-web/shared";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { accountLocalStorage as storage } from "./accountStorage";
import { ApiError, api, messageOf } from "./api";
import { Icon } from "./icons";
import { useWorkspaceDialog } from "./useWorkspaceDialog";
import "./file-batch.css";

type Operation = "copy" | "move" | "delete";
type Item = {
  request: FileRequest;
  status: "ready" | "pending" | "done" | "error" | "skipped";
  error?: string;
  collision?: boolean;
};
type Batch = { op: Operation; folder: string; items: Item[] };
const title = { copy: "Копирование", move: "Перемещение", delete: "Удаление" };
const inside = (path: string, parent: string) => path === parent || path.startsWith(parent + "/");
export function FileBatchActions({
  projectId,
  projectName,
  capability,
  checkout,
  folder,
  selection,
  selecting,
  visiblePaths,
  onSelection,
  onSelecting,
  onDone,
}: {
  projectId: string;
  projectName: string;
  capability: string;
  checkout: string;
  folder: string;
  selection: string[];
  selecting: boolean;
  visiblePaths: string[];
  onSelection: (paths: string[]) => void;
  onSelecting: (value: boolean) => void;
  onDone: (request: FileRequest) => void;
}) {
  const [clipboard, setClipboard] = useState<{ op: Operation; sources: FileSnapshot[] } | null>(
    null,
  );
  const [batch, setBatch] = useState<Batch | null>(null),
    [opened, setOpened] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null),
    current = useRef<Batch | null>(null),
    running = useRef(false),
    active = useRef(true),
    paused = useRef(false);
  const key = `file-batch:${projectId}:${checkout}`,
    url = `/projects/${encodeURIComponent(projectId)}/file-tools`;
  const completed = useRef(onDone);
  completed.current = onDone;
  useWorkspaceDialog(dialog, opened);
  const save = (value: Batch | null) => {
    if (!active.current) return;
    if (value) storage.setItem(key, JSON.stringify(value));
    else storage.removeItem(key);
    current.current = value;
    setBatch(value);
  };
  const patch = (id: string, changes: Partial<Item>) => {
    const value = current.current;
    if (value)
      save({
        ...value,
        items: value.items.map((item) => (item.request.id === id ? { ...item, ...changes } : item)),
      });
  };
  useEffect(() => {
    active.current = true;
    try {
      const value = JSON.parse(storage.getItem(key) ?? "null") as Batch | null;
      if (
        value &&
        ["copy", "move", "delete"].includes(value.op) &&
        Array.isArray(value.items) &&
        value.items.length <= 100 &&
        value.items.every(
          (item) =>
            item.request.op === value.op &&
            typeof item.request.path === "string" &&
            /^[a-f0-9-]{36}$/.test(item.request.id ?? "") &&
            /^[a-f0-9]{64}$/.test(item.request.fingerprint ?? "") &&
            ["ready", "pending", "done", "error", "skipped"].includes(item.status),
        )
      ) {
        current.current = value;
        setBatch(value);
      }
    } catch {
      setError("Не удалось восстановить файловую операцию.");
    }
    const end = () => {
      active.current = false;
      paused.current = true;
    };
    window.addEventListener("private-session-ended", end);
    return () => {
      end();
      window.removeEventListener("private-session-ended", end);
    };
  }, [key]);
  const unresolved = !!batch?.items.some((item) => !["done", "skipped"].includes(item.status));
  const prepare = async (op: Operation) => {
    if (running.current || unresolved || !selection.length) return;
    running.current = true;
    setBusy(true);
    setError("");
    try {
      // A selected folder already includes its selected descendants. Never act on both twice.
      const paths = selection.filter(
        (path) => !selection.some((parent) => parent !== path && inside(path, parent)),
      );
      const sources: FileSnapshot[] = [];
      for (const path of paths) {
        const source = await api<FileSnapshot>(`${url}?op=stat&path=${encodeURIComponent(path)}`);
        if (!active.current) return;
        if (source.checkout !== checkout)
          throw Error("Рабочая копия изменилась. Открой файлы заново.");
        sources.push(source);
      }
      if (op === "delete") {
        save({
          op,
          folder: "",
          items: sources.map((source) => ({
            request: {
              op,
              path: source.path,
              fingerprint: source.fingerprint,
              id: crypto.randomUUID(),
            },
            status: "ready",
          })),
        });
        setOpened(true);
      } else {
        setClipboard({ op, sources });
        onSelecting(false);
      }
    } catch (e) {
      if (active.current) setError(messageOf(e));
    } finally {
      running.current = false;
      if (active.current) setBusy(false);
    }
  };
  const paste = () => {
    if (!clipboard || unresolved) return;
    try {
      save({
        op: clipboard.op,
        folder,
        items: clipboard.sources.map((source) => {
          const target = [folder, source.path.split("/").at(-1)].filter(Boolean).join("/");
          return {
            request: {
              op: clipboard.op,
              path: source.path,
              fingerprint: source.fingerprint,
              id: crypto.randomUUID(),
              target,
            },
            status: source.path === target ? "error" : "ready",
            collision: source.path === target,
            error:
              source.path === target
                ? "Это исходный файл или папка. Выбери другое имя."
                : undefined,
          };
        }),
      });
      setClipboard(null);
      setError("");
      setOpened(true);
    } catch (e) {
      setError(messageOf(e));
    }
  };
  const execute = async (only?: string) => {
    if (running.current || !current.current) return;
    running.current = true;
    paused.current = false;
    setBusy(true);
    setError("");
    try {
      for (const item of current.current.items) {
        if (!active.current || paused.current) break;
        if (only ? item.request.id !== only : item.status !== "ready") continue;
        if (!["ready", "pending"].includes(item.status)) continue;
        // Write the exact operation before sending. Pending items are checked only explicitly.
        patch(item.request.id!, { status: "pending", error: undefined });
        try {
          await api<FileSnapshot>(url, { method: "POST", body: { ...item.request, capability } });
          if (!active.current) return;
          patch(item.request.id!, { status: "done", error: undefined });
          completed.current(item.request);
        } catch (e) {
          if (!active.current) return;
          const definitive =
            e instanceof ApiError &&
            e.status >= 400 &&
            e.status < 500 &&
            !["FILE_UNKNOWN", "FILE_LOCKED", "FILE_SCOPE_CHANGED"].includes(e.code);
          patch(item.request.id!, {
            status: definitive ? "error" : "pending",
            error: messageOf(e),
            collision: definitive && e instanceof ApiError && e.code === "FILE_EXISTS",
          });
          if (!definitive) break;
        }
      }
    } catch (e) {
      if (active.current) setError(messageOf(e));
    } finally {
      running.current = false;
      if (active.current) setBusy(false);
    }
  };
  const close = () => {
    paused.current = true;
    setOpened(false);
  };
  const forget = () => {
    try {
      save(null);
      setOpened(false);
    } catch (e) {
      setError(messageOf(e));
    }
  };
  const rename = (item: Item, name: string) => {
    if (!current.current || !name.trim() || /[\\/]/.test(name)) return;
    try {
      patch(item.request.id!, {
        request: {
          ...item.request,
          id: crypto.randomUUID(),
          target: [current.current.folder, name].filter(Boolean).join("/"),
        },
        status: "ready",
        error: undefined,
        collision: false,
      });
    } catch (e) {
      setError(messageOf(e));
    }
  };
  return (
    <>
      <section className="file-batch-controls" aria-label="Выбор и групповые действия">
        <div className="file-batch-pair">
          <button
            type="button"
            className="secondary"
            aria-pressed={selecting}
            disabled={busy}
            onClick={() => onSelecting(!selecting)}
          >
            {selecting ? "Готово" : "Выбрать несколько"}
            {selection.length ? ` · ${selection.length}` : ""}
          </button>
          {batch && (
            <button type="button" className="secondary" onClick={() => setOpened(true)}>
              Операция · {batch.items.filter((item) => item.status === "done").length}/
              {batch.items.length}
            </button>
          )}
        </div>
        {selecting && (
          <>
            <div className="file-batch-pair">
              <button
                type="button"
                className="secondary"
                aria-label="Выбрать на странице"
                disabled={busy}
                onClick={() => {
                  const next = [...new Set([...selection, ...visiblePaths])];
                  if (next.length > 100) setError("Можно выбрать до 100 элементов.");
                  else onSelection(next);
                }}
              >
                На странице
              </button>
              <button
                type="button"
                className="secondary"
                disabled={busy || !selection.length}
                onClick={() => onSelection([])}
              >
                Снять выбор
              </button>
            </div>
            <div className="file-batch-trio">
              <button
                type="button"
                className="secondary"
                disabled={busy || unresolved || !selection.length}
                onClick={() => void prepare("copy")}
              >
                Копировать
              </button>
              <button
                type="button"
                className="secondary"
                disabled={busy || unresolved || !selection.length}
                onClick={() => void prepare("move")}
              >
                Вырезать
              </button>
              <button
                type="button"
                className="secondary danger"
                disabled={busy || unresolved || !selection.length}
                onClick={() => void prepare("delete")}
              >
                Удалить
              </button>
            </div>
          </>
        )}
        {clipboard && (
          <div className="file-batch-pair">
            <button type="button" className="primary" disabled={busy || unresolved} onClick={paste}>
              Вставить сюда · {clipboard.sources.length}
            </button>
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => setClipboard(null)}
            >
              Отменить {clipboard.op === "copy" ? "копирование" : "перенос"}
            </button>
          </div>
        )}
        {busy && !opened && (
          <small role="status">{running.current ? "Обработка выбранных файлов…" : ""}</small>
        )}
        {error && !opened && (
          <p className="notice" role="alert">
            {error}
          </p>
        )}
      </section>
      {opened &&
        batch &&
        createPortal(
          <dialog
            ref={dialog}
            className="workspace-window file-batch-dialog"
            aria-label="Групповая операция"
            tabIndex={-1}
            onCancel={(e) => {
              e.preventDefault();
              e.stopPropagation();
              close();
            }}
          >
            <header className="panel-heading">
              <div>
                <strong>
                  {title[batch.op]} · {batch.items.length}
                </strong>
                <small title={projectName}>{projectName}</small>
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label="Закрыть групповую операцию"
                onClick={close}
              >
                <Icon name="close" />
              </button>
            </header>
            <p className="file-batch-summary">
              {batch.op === "delete"
                ? "Будут удалены перечисленные элементы и содержимое выбранных папок."
                : `Папка назначения: ${batch.folder || "Корень проекта"}`}
            </p>
            <div className="file-batch-items">
              {batch.items.map((item) => (
                <section
                  key={item.request.id}
                  className="file-batch-item"
                  aria-label={item.request.path}
                >
                  <strong>{item.request.path}</strong>
                  {item.request.target && <small>→ {item.request.target}</small>}
                  <p role="status">
                    {item.status === "done"
                      ? "Готово"
                      : item.status === "skipped"
                        ? "Пропущено"
                        : item.error ||
                          (item.status === "pending"
                            ? "Ожидает подтверждения"
                            : "Готов к выполнению")}
                  </p>
                  {item.status === "pending" && !busy && (
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => void execute(item.request.id)}
                    >
                      Проверить результат
                    </button>
                  )}
                  {item.collision && (
                    <form
                      className="file-batch-rename"
                      onSubmit={(e) => {
                        e.preventDefault();
                        const input = e.currentTarget.elements.namedItem(
                          "name",
                        ) as HTMLInputElement;
                        rename(item, input.value);
                      }}
                    >
                      <label>
                        Другое имя
                        <input
                          name="name"
                          aria-label={`Новое имя: ${item.request.path}`}
                          defaultValue={item.request.target
                            ?.split("/")
                            .at(-1)
                            ?.replace(/(\.[^.]+)?$/, " (копия)$1")}
                          required
                          pattern={"[^/\\\\]+"}
                          disabled={busy}
                        />
                      </label>
                      <button type="submit" className="secondary" disabled={busy}>
                        Сохранить оба
                      </button>
                    </form>
                  )}
                  {["ready", "error"].includes(item.status) && (
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy}
                      onClick={() => {
                        try {
                          patch(item.request.id!, {
                            status: "skipped",
                            error: undefined,
                            collision: false,
                          });
                        } catch (e) {
                          setError(messageOf(e));
                        }
                      }}
                    >
                      Пропустить
                    </button>
                  )}
                </section>
              ))}
            </div>
            {error && (
              <p className="notice" role="alert">
                {error}
              </p>
            )}
            <footer className="file-batch-pair">
              <button
                type="button"
                className={batch.op === "delete" ? "secondary danger" : "primary"}
                disabled={
                  busy ||
                  batch.items.some((item) => item.status === "pending") ||
                  !batch.items.some((item) => item.status === "ready")
                }
                onClick={() => void execute()}
              >
                {batch.op === "delete" ? "Подтвердить удаление" : "Выполнить"}
              </button>
              {busy ? (
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    paused.current = true;
                  }}
                >
                  Остановить после текущего
                </button>
              ) : (
                <button
                  type="button"
                  className="secondary"
                  disabled={batch.items.some((item) => item.status === "pending")}
                  onClick={forget}
                >
                  {unresolved ? "Отменить оставшиеся" : "Завершить"}
                </button>
              )}
            </footer>
          </dialog>,
          document.body,
        )}
    </>
  );
}
