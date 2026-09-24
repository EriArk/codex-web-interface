import {
  editableFile,
  type GitHubWorkObservation,
  type GitHubWorkReceipt,
  type RepositoryFiles,
} from "@codex-web/shared";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { accountLocalStorage as storage } from "./accountStorage";
import { api, messageOf } from "./api";
import { Icon } from "./icons";
import { useWorkspaceDialog } from "./useWorkspaceDialog";
import "./github-files.css";

const FileEditor = lazy(() => import("./FileEditor"));
type Operation = { id: string; state: string; receipt?: GitHubWorkReceipt };
type Review = {
  source?: string;
  id: string;
  input: Extract<GitHubWorkReceipt["input"], { kind: "repository-file" }>;
  binding: string;
  repositoryId: number;
  identityId: number;
  oldText: string;
  newText: string;
  operation?: Operation;
};
const decode = (s: string) =>
  new TextDecoder("utf-8", { fatal: true }).decode(
    Uint8Array.from(atob(s), (c) => c.charCodeAt(0)),
  );
function diff(before: string, after: string) {
  const a = before.split("\n"),
    b = after.split("\n");
  let start = 0,
    end = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  while (
    end < a.length - start &&
    end < b.length - start &&
    a[a.length - 1 - end] === b[b.length - 1 - end]
  )
    end++;
  const from = Math.max(0, start - 3),
    tail = Math.min(3, end);
  return [
    `@@ -${from + 1},${a.length - end - from + tail} +${from + 1},${b.length - end - from + tail} @@`,
    ...a.slice(Math.max(0, start - 3), start).map((v) => " " + v),
    ...a.slice(start, a.length - end).map((v) => "-" + v),
    ...b.slice(start, b.length - end).map((v) => "+" + v),
    ...a.slice(a.length - end, a.length - end + 3).map((v) => " " + v),
  ].join("\n");
}
export function GitHubFilesButton({
  projectId,
  projectName,
}: {
  projectId: string;
  projectName: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="secondary" type="button" onClick={() => setOpen(true)}>
        <Icon name="file" size={16} />
        Файлы GitHub
      </button>
      {open && (
        <GitHubFiles
          projectId={projectId}
          projectName={projectName}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
function GitHubFiles({
  projectId,
  projectName,
  onClose,
}: {
  projectId: string;
  projectName: string;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useWorkspaceDialog(dialog);
  const base = `/projects/${encodeURIComponent(projectId)}/github-files`,
    key = `workspace-github-file-review:${projectId}`;
  const [branch, setBranch] = useState(""),
    [data, setData] = useState<(GitHubWorkObservation & { binding: string }) | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [edit, setEdit] = useState<{
      file: File;
      source: string;
      snapshot: RepositoryFiles;
      observation: GitHubWorkObservation & { binding: string };
    } | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  // Restore after the parent modal enters the top layer, so recovery stays on top.
  useEffect(() => {
    try {
      const saved = JSON.parse(storage.getItem(key) ?? "null");
      if (
        saved?.input?.kind === "repository-file" &&
        typeof saved.oldText === "string" &&
        typeof saved.newText === "string"
      )
        setReview(saved);
    } catch {
      /* Unavailable local storage leaves the browser usable. */
    }
  }, [key]);
  const live = useRef(true),
    lock = useRef(false);
  const read = async (path = "", ref = branch) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      const v = await api<GitHubWorkObservation & { binding: string }>(base + "/read", {
        method: "POST",
        body: { kind: "repository-files", path, branch: ref },
      });
      if (live.current) {
        setData(v);
        setBranch(v.repositoryFiles?.branch ?? ref);
      }
    } catch (e) {
      if (live.current) setError(messageOf(e));
    } finally {
      lock.current = false;
      if (live.current) setBusy(false);
    }
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: Window is keyed to its project.
  useEffect(() => {
    live.current = true;
    void read("", "");
    return () => {
      live.current = false;
    };
  }, []);
  const snapshot = data?.repositoryFiles;
  const editFile = () => {
    try {
      if (!data || (!snapshot?.file?.content && snapshot?.file?.content !== "")) return;
      const f = snapshot.file!;
      decode(f.content!);
      const bytes = Uint8Array.from(atob(f.content!), (c) => c.charCodeAt(0));
      setEdit({
        file: new File([bytes], f.path.split("/").at(-1)!, { type: "text/plain" }),
        source: `github:${data.repositoryId}:${data.identity.id}:${snapshot.branch}:${snapshot.head}:${f.path}`,
        snapshot,
        observation: data,
      });
    } catch {
      setError("Файл не является текстом UTF-8.");
    }
  };
  return createPortal(
    <dialog
      ref={dialog}
      className="workspace-window github-files"
      aria-label="Файлы GitHub"
      onCancel={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }}
    >
      <header className="panel-heading">
        <div>
          <strong>Файлы GitHub</strong>
          <small>
            {projectName} · {data?.repository}
          </small>
        </div>
        <button
          className="icon-button"
          type="button"
          aria-label="Закрыть файлы GitHub"
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </header>
      <form
        className="github-file-branch"
        onSubmit={(e) => {
          e.preventDefault();
          void read("", branch);
        }}
      >
        <label>
          Ветка
          <input
            aria-label="Ветка GitHub"
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
          />
        </label>
        <button className="secondary" disabled={busy} type="submit">
          Открыть ветку
        </button>
      </form>
      <div className="github-file-body">
        {error && <p role="alert">{error}</p>}
        {busy && <p role="status">Читаю GitHub…</p>}
        {snapshot && (
          <>
            <div className="github-file-path">
              <button
                type="button"
                className="secondary"
                disabled={busy || !snapshot.path}
                onClick={() =>
                  void read(snapshot.path.split("/").slice(0, -1).join("/"), snapshot.branch)
                }
              >
                Папка выше
              </button>
              <span>{snapshot.path || "Корень"}</span>
            </div>
            {snapshot.entries?.map((e) => (
              <button
                type="button"
                className="github-file-entry"
                key={e.path}
                disabled={busy}
                onClick={() => void read(e.path, snapshot.branch)}
              >
                <Icon name={e.kind === "directory" ? "folder" : "file"} />
                <span>{e.name}</span>
              </button>
            ))}
            {snapshot.file && (
              <>
                <button
                  className="primary"
                  type="button"
                  disabled={!editableFile(snapshot.file.path) || snapshot.file.content === null}
                  onClick={editFile}
                >
                  Редактировать файл
                </button>
                <pre>
                  {snapshot.file.content !== null
                    ? (() => {
                        try {
                          return decode(snapshot.file!.content!);
                        } catch {
                          return "Не текст UTF-8";
                        }
                      })()
                    : "Для редактирования доступны текстовые файлы до 96 КБ."}
                </pre>
              </>
            )}
          </>
        )}
      </div>
      {edit && (
        <Suspense fallback={<p role="status">Открываю редактор…</p>}>
          <FileEditor
            projectId=""
            capability=""
            projectName={data?.repository ?? projectName}
            path={edit.file.name}
            copy={edit}
            onClose={() => setEdit(null)}
            onSaved={() => {}}
            reviewSave={async (file) => {
              const bytes = await file.arrayBuffer();
              if (bytes.byteLength > 98304) {
                throw Error("Прямое сохранение GitHub поддерживает текст до 96 КБ.");
              }
              const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes),
                oldText = decode(edit.snapshot.file!.content!);
              if (text === oldText) {
                throw Error("Файл не изменён.");
              }
              if (review) {
                setEdit(null);
                return;
              }
              const next: Review = {
                source: edit.source,
                id: crypto.randomUUID(),
                binding: edit.observation.binding,
                repositoryId: edit.observation.repositoryId!,
                identityId: edit.observation.identity.id,
                oldText,
                newText: text,
                input: {
                  kind: "repository-file",
                  branch: edit.snapshot.branch,
                  head: edit.snapshot.head,
                  title: `Update ${edit.snapshot.file!.path}`,
                  files: [
                    {
                      path: edit.snapshot.file!.path,
                      previous: edit.snapshot.file!.sha,
                      content: btoa(
                        Array.from(new Uint8Array(bytes), (v) => String.fromCharCode(v)).join(""),
                      ),
                    },
                  ],
                },
              };
              storage.setItem(key, JSON.stringify(next));
              setReview(next);
            }}
          />
        </Suspense>
      )}
      {review && (
        <GitHubFileReview
          value={review}
          base={base}
          storageKey={key}
          onChange={setReview}
          onBack={
            edit
              ? () => {
                  storage.removeItem(key);
                  setReview(null);
                }
              : undefined
          }
          onClose={onClose}
          onDone={() => {
            storage.removeItem(key);
            storage.removeItem(`workspace-file-copy:${review.source}`);
            setReview(null);
            setEdit(null);
            void read(snapshot?.path ?? "", snapshot?.branch ?? branch);
          }}
        />
      )}
    </dialog>,
    document.body,
  );
}
function GitHubFileReview({
  value,
  base,
  storageKey,
  onChange,
  onClose,
  onDone,
  onBack,
}: {
  value: Review;
  base: string;
  storageKey: string;
  onChange: (v: Review) => void;
  onClose: () => void;
  onDone: () => void;
  onBack?: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useWorkspaceDialog(dialog);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const lock = useRef(false),
    live = useRef(true);
  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );
  const run = async (action: "prepare" | "confirm" | "status") => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      const pending =
        action === "confirm"
          ? { ...value, operation: { ...value.operation!, state: "unknown" } }
          : value;
      storage.setItem(storageKey, JSON.stringify(pending));
      if (action === "confirm") onChange(pending);
      const operation = await api<Operation>(`${base}/${value.id}/${action}`, {
        method: "POST",
        body:
          action === "prepare"
            ? {
                input: value.input,
                binding: value.binding,
                repositoryId: value.repositoryId,
                identityId: value.identityId,
              }
            : action === "confirm"
              ? { fingerprint: value.operation?.receipt?.fingerprint }
              : {},
      });
      const next = { ...value, operation };
      storage.setItem(storageKey, JSON.stringify(next));
      if (live.current) onChange(next);
    } catch (e) {
      if (live.current) setError(messageOf(e));
    } finally {
      lock.current = false;
      if (live.current) setBusy(false);
    }
  };
  const refresh = async () => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      const v = await api<GitHubWorkObservation & { binding: string }>(base + "/read", {
        method: "POST",
        body: {
          kind: "repository-files",
          branch: value.input.branch,
          path: value.input.files[0]!.path,
        },
      });
      if (
        v.binding !== value.binding ||
        v.identity.id !== value.identityId ||
        v.repositoryId !== value.repositoryId ||
        !v.repositoryFiles?.file ||
        v.repositoryFiles.file.content === null
      )
        throw Error("Доступ или источник изменился. Открой файл заново.");
      const next: Review = {
        ...value,
        id: crypto.randomUUID(),
        operation: undefined,
        oldText: decode(v.repositoryFiles.file.content),
        input: {
          ...value.input,
          head: v.repositoryFiles.head,
          files: [{ ...value.input.files[0]!, previous: v.repositoryFiles.file.sha }],
        },
      };
      storage.setItem(storageKey, JSON.stringify(next));
      if (live.current) onChange(next);
    } catch (e) {
      if (live.current) setError(messageOf(e));
    } finally {
      lock.current = false;
      if (live.current) setBusy(false);
    }
  };
  const state = value.operation?.state;
  return createPortal(
    <dialog
      ref={dialog}
      className="workspace-window github-file-review"
      aria-label="Коммит GitHub"
      onCancel={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }}
    >
      <header className="panel-heading">
        <div>
          <strong>Коммит GitHub</strong>
          <small>
            {value.input.branch} · {value.input.files[0]!.path}
          </small>
        </div>
        <button
          className="icon-button"
          type="button"
          aria-label="Закрыть коммит GitHub"
          disabled={busy}
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </header>
      <div className="github-file-body">
        <label>
          Сообщение коммита
          <input
            aria-label="Сообщение коммита"
            value={value.input.title}
            disabled={!!value.operation || busy}
            onChange={(e) =>
              onChange({ ...value, input: { ...value.input, title: e.target.value } })
            }
          />
        </label>
        <section aria-label="Изменения файла">
          <pre>{diff(value.oldText, value.newText)}</pre>
        </section>
        {error && <p role="alert">{error}</p>}
        <div className="github-file-review-tools">
          {onBack && (!state || state === "prepared" || state === "failed") && (
            <button className="secondary" type="button" disabled={busy} onClick={onBack}>
              К редактору
            </button>
          )}
          {(!state || state === "failed") && (
            <button
              className="secondary"
              type="button"
              disabled={busy}
              onClick={() => void refresh()}
            >
              Обновить сравнение
            </button>
          )}
        </div>
        {state && (
          <p role="status">
            {state === "completed"
              ? "Коммит сохранён"
              : state === "prepared"
                ? "Изменения проверены. Можно создать коммит."
                : state === "failed"
                  ? "GitHub отклонил изменение. Обнови файл и сравни версии."
                  : "Результат ещё не подтверждён. Проверь сохранение."}
          </p>
        )}
      </div>
      <footer className="file-copy-actions">
        <button
          className="secondary"
          type="button"
          disabled={busy}
          onClick={() => void run("status")}
        >
          Проверить результат
        </button>
        {state === "completed" ? (
          <button className="primary" type="button" onClick={onDone}>
            Готово
          </button>
        ) : (
          <button
            className="primary"
            type="button"
            disabled={busy || !value.input.title.trim() || (!!state && state !== "prepared")}
            onClick={() => void run(state === "prepared" ? "confirm" : "prepare")}
          >
            {state === "prepared" ? "Создать коммит" : "Подготовить коммит"}
          </button>
        )}
      </footer>
    </dialog>,
    document.body,
  );
}
