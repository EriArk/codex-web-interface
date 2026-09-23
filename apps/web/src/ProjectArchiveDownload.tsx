import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { accountLocalStorage as storage } from "./accountStorage";
import { ApiError, api, messageOf } from "./api";
import { DownloadLink } from "./DownloadLink";
import { Icon } from "./icons";
import { useWorkspaceDialog } from "./useWorkspaceDialog";

type Task = { id: string; paths: string[] };
type Result = { state: string; url?: string; name?: string; bytes: number };
export function ProjectArchiveDownload({
  projectId,
  projectName,
  checkout,
  selection,
  selecting,
}: {
  projectId: string;
  projectName: string;
  checkout: string;
  selection: string[];
  selecting: boolean;
}) {
  const [task, setTask] = useState<Task | null>(null),
    [result, setResult] = useState<Result | null>(null),
    [opened, setOpened] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null),
    active = useRef(true),
    working = useRef(false),
    cancelled = useRef(false);
  const key = `file-archive:${projectId}:${checkout}`,
    base = `/projects/${encodeURIComponent(projectId)}/file-archives`;
  useWorkspaceDialog(dialog, opened);
  useEffect(() => {
    active.current = true;
    try {
      const value = JSON.parse(storage.getItem(key) ?? "null");
      if (
        value &&
        /^[a-f0-9-]{36}$/.test(value.id) &&
        Array.isArray(value.paths) &&
        value.paths.length <= 100 &&
        value.paths.every((p: unknown) => typeof p === "string")
      )
        setTask(value);
    } catch {
      setError("Не удалось восстановить подготовку ZIP.");
    }
    const end = () => {
      active.current = false;
    };
    window.addEventListener("private-session-ended", end);
    return () => {
      end();
      window.removeEventListener("private-session-ended", end);
    };
  }, [key]);
  const prepare = async (value: Task) => {
    if (working.current) return;
    working.current = true;
    cancelled.current = false;
    setBusy(true);
    setError("");
    try {
      storage.setItem(key, JSON.stringify(value));
      setTask(value);
      const answer = await api<Result>(`${base}/${value.id}`, {
        method: "POST",
        body: { paths: value.paths, checkout },
        timeoutMs: 135000,
      });
      if (active.current && !cancelled.current) setResult(answer);
    } catch (e) {
      if (active.current && !cancelled.current) setError(messageOf(e));
    } finally {
      working.current = false;
      if (active.current) setBusy(false);
    }
  };
  const discard = async () => {
    if (!task) return;
    try {
      cancelled.current = true;
      await api(`${base}/${task.id}`, { method: "DELETE" }).catch((e) => {
        if (!(e instanceof ApiError && e.code === "ARCHIVE_MISSING")) throw e;
      });
      if (!active.current) return;
      storage.removeItem(key);
      setTask(null);
      setResult(null);
      setOpened(false);
      setError("");
    } catch (e) {
      if (active.current) setError(messageOf(e));
    }
  };
  return (
    <>
      {(selecting || task) && (
        <button
          type="button"
          className="secondary"
          disabled={!task && !selection.length}
          onClick={() => {
            setOpened(true);
            setError("");
            if (!task) {
              const value = { id: crypto.randomUUID(), paths: [...selection] };
              setTask(value);
              setResult(null);
            }
          }}
        >
          {task ? "Архив ZIP" : "Скачать ZIP"}
        </button>
      )}
      {opened &&
        task &&
        createPortal(
          <dialog
            ref={dialog}
            className="workspace-window file-batch-dialog"
            aria-label="Архив ZIP"
            tabIndex={-1}
            onCancel={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setOpened(false);
            }}
          >
            <header className="panel-heading">
              <div>
                <strong>Архив ZIP · {task.paths.length}</strong>
                <small title={projectName}>{projectName}</small>
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label="Закрыть архив"
                onClick={() => setOpened(false)}
              >
                <Icon name="close" />
              </button>
            </header>
            <p className="file-batch-summary">
              Файлы и папки сохранят пути внутри проекта. До 2000 элементов и 32 МБ.
            </p>
            <div className="file-batch-items">
              {task.paths.map((path) => (
                <div key={path} className="file-batch-item">
                  {path}
                </div>
              ))}
            </div>
            {busy && <p role="status">Готовлю ZIP…</p>}
            {error && (
              <p className="notice" role="alert">
                {error}
              </p>
            )}
            {result?.state === "cancelled" && <p role="status">Подготовка отменена.</p>}
            <footer className="file-batch-pair">
              {result?.state === "ready" ? (
                <DownloadLink href={result.url} name={result.name} directDownload>
                  Скачать ZIP
                </DownloadLink>
              ) : (
                <button
                  type="button"
                  className="primary"
                  disabled={busy || result?.state === "cancelled"}
                  onClick={() => void prepare(task)}
                >
                  Подготовить / проверить
                </button>
              )}
              <button type="button" className="secondary" onClick={() => void discard()}>
                {result?.state === "ready" ? "Удалить архив" : "Отменить"}
              </button>
            </footer>
          </dialog>,
          document.body,
        )}
    </>
  );
}
