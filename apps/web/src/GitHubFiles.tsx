import {
  editableFile,
  type GitHubWorkInput,
  type GitHubWorkObservation,
  type GitHubWorkReceipt,
  type RepositoryFiles,
} from "@codex-web/shared";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ActivitySourceWindow } from "./ActivitySourceWindow";
import { accountLocalStorage as storage } from "./accountStorage";
import { ApiError, api, messageOf } from "./api";
import "./space-activity.css";
import { Icon } from "./icons";
import { useWorkspaceDialog } from "./useWorkspaceDialog";
import "./github-files.css";

const FileEditor = lazy(() => import("./FileEditor"));
type Operation = { id: string; state: string; receipt?: GitHubWorkReceipt };
type Step = {
  id: string;
  input: Extract<GitHubWorkInput, { kind: "repository-branch" | "repository-pr" }>;
  operation?: Operation;
};
type Review = {
  origin?: GitHubWorkObservation & { binding: string };
  baseBranch?: string;
  newBranch?: string;
  branchStep?: Step;
  prStep?: Step;
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
      baseBranch?: string;
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
                baseBranch: edit.baseBranch ?? edit.snapshot.branch,
                origin: edit.observation,
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
          projectId={projectId}
          base={base}
          storageKey={key}
          onChange={setReview}
          onBack={
            edit || review.origin?.repositoryFiles?.file?.content != null
              ? () => {
                  const origin = review.origin ?? edit!.observation;
                  const original = origin.repositoryFiles!.file!;
                  const bytes = Uint8Array.from(atob(original.content!), (c) => c.charCodeAt(0));
                  setEdit({
                    file: new File([bytes], original.path.split("/").at(-1)!, {
                      type: "text/plain",
                    }),
                    source: review.source!,
                    observation: origin,
                    baseBranch: review.baseBranch,
                    snapshot: {
                      ...origin.repositoryFiles!,
                      branch: review.input.branch,
                      head: review.input.head,
                    },
                  });
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
            void read(review.input.files[0]!.path, review.input.branch);
          }}
        />
      )}
    </dialog>,
    document.body,
  );
}
function GitHubFileReview({
  value,
  projectId,
  base,
  storageKey,
  onChange,
  onClose,
  onDone,
  onBack,
}: {
  value: Review;
  projectId: string;
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
  const [inspectPr, setInspectPr] = useState(false);
  const update = (next: Review) => {
    try {
      storage.setItem(storageKey, JSON.stringify(next));
      onChange(next);
      return true;
    } catch {
      setError("Не удалось сохранить черновик на устройстве.");
      return false;
    }
  };
  const target = value.prStep
    ? "pr"
    : value.newBranch !== undefined && value.branchStep?.operation?.state !== "completed"
      ? "branch"
      : "commit";
  const selected = target === "pr" ? value.prStep : target === "branch" ? value.branchStep : value;
  const state = selected?.operation?.state;
  const run = async (action: "prepare" | "confirm" | "status") => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    let step = selected;
    if (target === "branch" && !step)
      step = {
        id: crypto.randomUUID(),
        input: {
          kind: "repository-branch",
          branch: value.newBranch!.trim(),
          base: value.input.branch,
          head: value.input.head,
        },
      };
    if (!step) {
      lock.current = false;
      setBusy(false);
      return;
    }
    const keep = (operation?: Operation) => {
      const currentStep = { ...step!, operation };
      const next: Review =
        target === "commit"
          ? { ...value, operation }
          : target === "pr"
            ? { ...value, prStep: currentStep as Step }
            : { ...value, branchStep: currentStep as Step };
      if (target === "branch" && operation?.state === "completed")
        next.input = { ...value.input, branch: step!.input.branch };
      return next;
    };
    try {
      const pending =
        action === "confirm"
          ? { ...step.operation!, state: "unknown" }
          : action === "prepare"
            ? { id: step.id, state: "preparing" }
            : step.operation;
      if (!update(keep(pending))) return;
      const operation = await api<Operation>(`${base}/${step.id}/${action}`, {
        method: "POST",
        body:
          action === "prepare"
            ? {
                input: step.input,
                binding: value.binding,
                repositoryId: value.repositoryId,
                identityId: value.identityId,
              }
            : action === "confirm"
              ? { fingerprint: step.operation?.receipt?.fingerprint }
              : {},
      });
      const next = keep(operation);
      storage.setItem(storageKey, JSON.stringify(next));
      if (live.current) onChange(next);
    } catch (e) {
      if (live.current) {
        if (
          action === "status" &&
          e instanceof ApiError &&
          e.status === 404 &&
          step.operation?.state === "preparing"
        )
          update(keep(undefined));
        setError(messageOf(e));
      }
    } finally {
      lock.current = false;
      if (live.current) setBusy(false);
    }
  };
  const startPr = () => {
    const head = value.operation?.receipt?.result?.sha;
    if (!head) {
      setError("Сначала проверь сохранённый коммит.");
      return;
    }
    update({
      ...value,
      prStep: {
        id: crypto.randomUUID(),
        input: {
          kind: "repository-pr",
          branch: value.input.branch,
          head,
          base: value.baseBranch !== value.input.branch ? (value.baseBranch ?? "") : "",
          title: value.input.title,
          body: "",
        },
      },
    });
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
        branchStep:
          value.branchStep?.operation?.state === "completed" ? value.branchStep : undefined,
        oldText: decode(v.repositoryFiles.file.content),
        origin: v,
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
          <strong>
            {target === "pr" ? "Новый PR" : target === "branch" ? "Новая ветка" : "Коммит GitHub"}
          </strong>
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
        {target !== "pr" ? (
          <>
            {!value.operation && !value.branchStep && (
              <div className="github-edit-destination">
                <label>
                  Сохранение
                  <select
                    aria-label="Куда сохранить коммит"
                    value={value.newBranch === undefined ? "current" : "new"}
                    disabled={busy}
                    onChange={(e) =>
                      update({
                        ...value,
                        newBranch:
                          e.target.value === "new"
                            ? "edit/" + crypto.randomUUID().slice(0, 8)
                            : undefined,
                      })
                    }
                  >
                    <option value="current">В текущую ветку</option>
                    <option value="new">В новую ветку</option>
                  </select>
                </label>
                {value.newBranch !== undefined && (
                  <label>
                    Новая ветка
                    <input
                      aria-label="Название новой ветки"
                      maxLength={240}
                      value={value.newBranch}
                      disabled={busy}
                      onChange={(e) => update({ ...value, newBranch: e.target.value })}
                    />
                  </label>
                )}
              </div>
            )}
            {value.branchStep && (
              <p>
                Ветка: <strong>{value.branchStep.input.branch}</strong>
                {value.branchStep.operation?.state === "completed" ? " · Создана" : ""}
              </p>
            )}
            <label>
              Сообщение коммита
              <input
                aria-label="Сообщение коммита"
                maxLength={200}
                value={value.input.title}
                disabled={!!value.operation || busy}
                onChange={(e) =>
                  update({ ...value, input: { ...value.input, title: e.target.value } })
                }
              />
            </label>
            <section aria-label="Изменения файла">
              <pre>{diff(value.oldText, value.newText)}</pre>
            </section>
          </>
        ) : (
          value.prStep?.input.kind === "repository-pr" && (
            <div className="github-pr-fields">
              <p>
                Ветка: <strong>{value.prStep.input.branch}</strong> · Коммит{" "}
                <code>{value.prStep.input.head.slice(0, 8)}</code>
              </p>
              <label>
                Влить в ветку
                <input
                  aria-label="Базовая ветка PR"
                  maxLength={240}
                  value={value.prStep.input.base}
                  disabled={!!value.prStep.operation || busy}
                  onChange={(e) =>
                    update({
                      ...value,
                      prStep: {
                        ...value.prStep!,
                        input: { ...value.prStep!.input, base: e.target.value },
                      },
                    })
                  }
                />
              </label>
              <label>
                Заголовок PR
                <input
                  aria-label="Заголовок PR"
                  maxLength={200}
                  value={value.prStep.input.title}
                  disabled={!!value.prStep.operation || busy}
                  onChange={(e) =>
                    update({
                      ...value,
                      prStep: {
                        ...value.prStep!,
                        input: { ...value.prStep!.input, title: e.target.value } as Step["input"],
                      },
                    })
                  }
                />
              </label>
              <label>
                Описание
                <textarea
                  aria-label="Описание PR"
                  maxLength={16000}
                  rows={6}
                  value={value.prStep.input.body}
                  disabled={!!value.prStep.operation || busy}
                  onChange={(e) =>
                    update({
                      ...value,
                      prStep: {
                        ...value.prStep!,
                        input: { ...value.prStep!.input, body: e.target.value } as Step["input"],
                      },
                    })
                  }
                />
              </label>
            </div>
          )
        )}
        {error && <p role="alert">{error}</p>}
        <div className="github-file-review-tools">
          {onBack && target !== "pr" && (!state || state === "prepared" || state === "failed") && (
            <button className="secondary" type="button" disabled={busy} onClick={onBack}>
              К редактору
            </button>
          )}
          {target !== "pr" && (!state || state === "failed") && (
            <button
              className="secondary"
              type="button"
              disabled={busy}
              onClick={() => void refresh()}
            >
              Обновить сравнение
            </button>
          )}
          {target === "pr" && (!state || state === "failed") && (
            <button
              className="secondary"
              type="button"
              disabled={busy}
              onClick={() => update({ ...value, prStep: undefined })}
            >
              К коммиту
            </button>
          )}
          {state === "failed" && target !== "commit" && (
            <button
              className="secondary"
              type="button"
              disabled={busy}
              onClick={() =>
                update(
                  target === "branch"
                    ? { ...value, branchStep: undefined }
                    : {
                        ...value,
                        prStep: { ...value.prStep!, id: crypto.randomUUID(), operation: undefined },
                      },
                )
              }
            >
              Изменить параметры
            </button>
          )}
        </div>
        {state && (
          <p role="status">
            {state === "completed"
              ? target === "pr"
                ? "PR создан"
                : "Коммит сохранён"
              : state === "prepared"
                ? target === "branch"
                  ? "Ветка проверена. Можно создать."
                  : target === "pr"
                    ? "PR проверен. Можно опубликовать."
                    : "Изменения проверены. Можно создать коммит."
                : state === "failed"
                  ? "GitHub отклонил изменение. Проверь параметры и версии."
                  : "Результат ещё не подтверждён. Проверь сохранение."}
          </p>
        )}
      </div>
      <footer className="file-copy-actions">
        {state === "completed" ? (
          <>
            {target === "commit" ? (
              <button className="secondary" type="button" onClick={startPr}>
                Создать PR
              </button>
            ) : (
              <button className="secondary" type="button" onClick={() => setInspectPr(true)}>
                Открыть PR
              </button>
            )}
            <button className="primary" type="button" onClick={onDone}>
              Готово
            </button>
          </>
        ) : (
          <>
            <button
              className="secondary"
              type="button"
              disabled={busy || !selected?.operation}
              onClick={() => void run("status")}
            >
              Проверить результат
            </button>
            <button
              className="primary"
              type="button"
              disabled={
                busy ||
                (!!state && state !== "prepared") ||
                (target === "branch"
                  ? !value.newBranch?.trim() || value.newBranch.trim() === value.input.branch
                  : target === "pr" && value.prStep?.input.kind === "repository-pr"
                    ? !value.prStep.input.title.trim() ||
                      !value.prStep.input.base.trim() ||
                      value.prStep.input.base === value.prStep.input.branch
                    : !value.input.title.trim())
              }
              onClick={() => void run(state === "prepared" ? "confirm" : "prepare")}
            >
              {target === "branch"
                ? state === "prepared"
                  ? "Создать ветку"
                  : "Подготовить ветку"
                : target === "pr"
                  ? state === "prepared"
                    ? "Опубликовать PR"
                    : "Подготовить PR"
                  : state === "prepared"
                    ? "Создать коммит"
                    : "Подготовить коммит"}
            </button>
          </>
        )}
      </footer>
      {inspectPr &&
        value.prStep?.operation?.receipt?.result?.number &&
        createPortal(
          <ActivitySourceWindow
            personalProjectId={projectId}
            target={{
              projectId,
              repositoryId: value.repositoryId,
              source: {
                kind: "pr",
                key: `pr:${value.prStep.operation.receipt.result.number}`,
                number: value.prStep.operation.receipt.result.number,
                title:
                  value.prStep.input.kind === "repository-pr" ? value.prStep.input.title : "PR",
                url: value.prStep.operation.receipt.result.url!,
                author: value.prStep.operation.receipt.snapshot.identity,
                authorName: value.prStep.operation.receipt.snapshot.identity.login,
                at: new Date(value.prStep.operation.receipt.updatedAt).toISOString(),
                state: "open",
              },
            }}
            onClose={() => setInspectPr(false)}
          />,
          document.body,
        )}
    </dialog>,
    document.body,
  );
}
