import { type FileSnapshot, UPLOAD_CHUNK_BYTES } from "@codex-web/shared";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { accountLocalStorage as storage } from "./accountStorage";
import { ApiError, api, messageOf } from "./api";
import { Icon } from "./icons";
import { useWorkspaceDialog } from "./useWorkspaceDialog";
import "./project-file-upload.css";

type Row = {
  id: string;
  name: string;
  originalName: string;
  bytes: number;
  folder: string;
  status: "queued" | "uploading" | "committing" | "done" | "error" | "cancelled" | "conflict";
  offset: number;
  started: boolean;
  replace?: string;
  error?: string;
  conflict?: FileSnapshot;
};
type State = {
  offset: number;
  bytes: number;
  result: { file?: FileSnapshot; cancelled?: boolean } | null;
};
const size = (n: number) =>
  n < 1024
    ? `${n} Б`
    : new Intl.NumberFormat("ru", { maximumFractionDigits: 1 }).format(n / 1024) + " КБ";
export function ProjectFileUpload({
  projectId,
  projectName,
  capability,
  checkout,
  folder,
  onDone,
}: {
  projectId: string;
  projectName: string;
  capability: string;
  checkout: string;
  folder: string;
  onDone: (path: string) => void;
}) {
  const [opened, setOpened] = useState(false),
    [rows, setRows] = useState<Row[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null),
    picker = useRef<HTMLInputElement>(null),
    selectedAgain = useRef("");
  useWorkspaceDialog(dialog, opened);
  const records = useRef<Row[]>([]),
    files = useRef(new Map<string, File>()),
    running = useRef(false),
    active = useRef(true);
  const paused = useRef(false);
  const control = useRef<{
    id: string;
    abort: AbortController;
    phase: string;
    cancel: boolean;
  } | null>(null);
  const key = `workspace-file-uploads:${projectId}:${checkout}`,
    base = `/projects/${encodeURIComponent(projectId)}/file-uploads`;
  const options = { fileCapability: capability };
  const update = (next: Row[]) => {
    if (!active.current) return;
    // Commit recovery metadata before issuing any mutation; never persist binary file data.
    storage.setItem(
      key,
      JSON.stringify(next.filter((r) => !["done", "cancelled"].includes(r.status))),
    );
    records.current = next;
    setRows(next);
  };
  const change = (id: string, patch: Partial<Row>) =>
    update(records.current.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  useEffect(() => {
    active.current = true;
    try {
      const saved = JSON.parse(storage.getItem(key) ?? "[]");
      if (Array.isArray(saved)) {
        const restored = saved
          .slice(0, 32)
          .filter(
            (r) =>
              /^[a-f0-9-]{36}$/.test(r.id) &&
              typeof r.name === "string" &&
              typeof r.folder === "string" &&
              Number.isSafeInteger(r.bytes) &&
              r.bytes >= 0,
          )
          .map((r) => ({
            ...r,
            status: "error" as const,
            error: "Загрузка приостановлена. Проверь её или выбери исходный файл снова.",
          }));
        records.current = restored;
        setRows(restored);
      }
    } catch {
      setError("Не удалось восстановить очередь загрузки.");
    }
    const end = () => {
      active.current = false;
      control.current?.abort.abort();
    };
    window.addEventListener("private-session-ended", end);
    return () => {
      end();
      window.removeEventListener("private-session-ended", end);
    };
  }, [key]);
  const pathOf = (row: Row) => (row.folder ? row.folder + "/" + row.name : row.name);
  const cancelRow = async (row: Row) => {
    const state = row.started
      ? await api<State>(`${base}/${row.id}`, { ...options, method: "DELETE" }).catch((e) => {
          if (e instanceof ApiError && e.code === "UPLOAD_MISSING") return null;
          throw e;
        })
      : null;
    if (state?.result?.file) {
      change(row.id, { status: "done", offset: row.bytes, error: undefined });
      onDone(state.result.file.path);
      return false;
    }
    change(row.id, { status: "cancelled", error: undefined });
    files.current.delete(row.id);
    return true;
  };
  const choose = async (row: Row, replace: boolean) => {
    try {
      const file = files.current.get(row.id);
      if (!(await cancelRow(row))) return;
      const next = {
        ...row,
        id: crypto.randomUUID(),
        started: false,
        offset: 0,
        status: "queued" as const,
        error: undefined,
        conflict: undefined,
        replace: replace ? row.conflict?.fingerprint : undefined,
        name: replace ? row.name : row.name.replace(/(\.[^.]+)?$/, " (копия)$1"),
      };
      if (file) files.current.set(next.id, file);
      update(records.current.map((r) => (r.id === row.id ? next : r)));
    } catch (e) {
      setError(messageOf(e));
    }
  };
  const upload = async (initial: Row) => {
    const controller = new AbortController();
    control.current = { id: initial.id, abort: controller, phase: "uploading", cancel: false };
    let started = initial.started;
    try {
      started = true;
      change(initial.id, {
        status: "uploading",
        started: true,
        error: undefined,
        conflict: undefined,
      });
      const opts = { ...options, signal: controller.signal };
      const url = `${base}/${initial.id}`;
      const state = await api<State>(url, {
        ...opts,
        method: "POST",
        body: {
          name: initial.name,
          bytes: initial.bytes,
          folder: initial.folder,
          checkout,
          ...(initial.replace ? { replace: initial.replace } : {}),
        },
      });
      started = true;
      change(initial.id, { started: true, offset: state.offset });
      if (state.result?.cancelled) {
        change(initial.id, { status: "cancelled" });
        return;
      }
      if (state.result?.file) {
        change(initial.id, { status: "done", offset: initial.bytes });
        onDone(state.result.file.path);
        return;
      }
      if (state.bytes !== initial.bytes || state.offset < 0 || state.offset > initial.bytes)
        throw Error("Состояние загрузки изменилось.");
      const file = files.current.get(initial.id);
      if (state.offset < initial.bytes && !file)
        throw Error("Выбери исходный файл снова для продолжения.");
      // On a reselected File, validate saved prefix chunks byte-for-byte before appending.
      if (file)
        for (let offset = 0; offset < file.size; offset += UPLOAD_CHUNK_BYTES) {
          const end = Math.min(file.size, offset + UPLOAD_CHUNK_BYTES);
          const part = await api<State>(`${url}?offset=${offset}`, {
            ...opts,
            method: "PUT",
            raw: file.slice(offset, end),
          });
          if (part.result?.cancelled || part.offset < end || part.offset > initial.bytes)
            throw Error("Загрузка изменилась.");
          change(initial.id, { offset: part.offset });
        }
      if (controller.signal.aborted) throw controller.signal.reason;
      change(initial.id, { status: "committing", offset: initial.bytes });
      control.current.phase = "committing";
      const result = await api<{ file: FileSnapshot }>(url + "/complete", {
        ...opts,
        method: "POST",
        body: {},
        timeoutMs: 1860000,
      });
      change(initial.id, { status: "done", error: undefined });
      files.current.delete(initial.id);
      onDone(result.file.path);
    } catch (e) {
      if (!active.current) return;
      const row = { ...initial, started };
      if (control.current?.cancel) {
        try {
          await cancelRow(row);
        } catch (failure) {
          change(initial.id, { status: "error", started, error: messageOf(failure) });
        }
      } else if (e instanceof ApiError && ["FILE_EXISTS", "FILE_CHANGED"].includes(e.code)) {
        const conflict = await api<FileSnapshot>(
          `/projects/${encodeURIComponent(projectId)}/file-tools?op=stat&path=${encodeURIComponent(pathOf(initial))}`,
        ).catch(() => undefined);
        change(initial.id, {
          status: "conflict",
          started,
          conflict,
          error:
            e.code === "FILE_CHANGED"
              ? "Существующий файл изменился. Выбери действие заново."
              : "Файл с таким именем уже существует.",
        });
      } else
        change(initial.id, {
          status: "error",
          started,
          error: controller.signal.aborted ? "Загрузка приостановлена." : messageOf(e),
        });
    } finally {
      control.current = null;
    }
  };
  const start = async (only?: string) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    paused.current = false;
    try {
      for (const row of records.current.filter((r) =>
        only ? r.id === only : ["queued", "error"].includes(r.status),
      )) {
        if (!active.current || paused.current) break;
        await upload(row);
      }
    } catch (e) {
      if (active.current) setError(messageOf(e));
    } finally {
      running.current = false;
      if (active.current) setBusy(false);
    }
  };
  const close = () => {
    if (control.current?.phase === "committing") return;
    paused.current = true;
    control.current?.abort.abort();
    setOpened(false);
  };
  const pending = rows.filter((r) => !["done", "cancelled"].includes(r.status)).length;
  return (
    <>
      <button type="button" className="secondary" onClick={() => setOpened(true)}>
        <Icon name="file" size={16} /> Загрузить файлы{pending ? ` · ${pending}` : ""}
      </button>
      {opened &&
        createPortal(
          <dialog
            ref={dialog}
            className="workspace-window project-file-upload"
            aria-label="Загрузка файлов"
            tabIndex={-1}
            onCancel={(e) => {
              e.stopPropagation();
              if (e.target !== e.currentTarget) return;
              e.preventDefault();
              close();
            }}
          >
            <header className="panel-heading">
              <div>
                <strong>Загрузка файлов</strong>
                <small title={`${projectName} / ${folder}`}>
                  {projectName} / {folder || "Корень проекта"}
                </small>
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label="Закрыть загрузку"
                disabled={rows.some((r) => r.status === "committing")}
                onClick={close}
              >
                <Icon name="close" />
              </button>
            </header>
            <input
              ref={picker}
              type="file"
              multiple
              hidden
              aria-label="Выбрать файлы для загрузки"
              onChange={(e) => {
                try {
                  const chosen = Array.from(e.target.files ?? []),
                    again = selectedAgain.current;
                  selectedAgain.current = "";
                  if (again) {
                    const row = records.current.find((r) => r.id === again),
                      file = chosen[0];
                    if (!row || !file || file.name !== row.originalName || file.size !== row.bytes)
                      throw Error("Выбери тот же исходный файл: имя и размер должны совпадать.");
                    files.current.set(again, file);
                    change(again, { status: "queued", error: undefined });
                  } else {
                    const keep = records.current.filter(
                      (r) => !["done", "cancelled"].includes(r.status),
                    );
                    if (keep.length + chosen.length > 32)
                      throw Error("В одной очереди — до 32 файлов.");
                    const next = chosen.map((file) => {
                      const row: Row = {
                        id: crypto.randomUUID(),
                        name: file.name,
                        originalName: file.name,
                        bytes: file.size,
                        folder,
                        status: "queued",
                        offset: 0,
                        started: false,
                      };
                      files.current.set(row.id, file);
                      return row;
                    });
                    update([...keep, ...next]);
                  }
                  setError("");
                } catch (err) {
                  setError(messageOf(err));
                }
                e.target.value = "";
              }}
            />
            <div className="upload-batch-actions">
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => {
                  selectedAgain.current = "";
                  picker.current?.click();
                }}
              >
                Добавить файлы
              </button>
              <button
                type="button"
                className="primary"
                disabled={busy || !rows.some((r) => ["queued", "error"].includes(r.status))}
                onClick={() => void start()}
              >
                Загрузить
              </button>
            </div>
            {error && (
              <p className="notice" role="alert">
                {error}
              </p>
            )}
            <div className="upload-list">
              {!rows.length && (
                <p>Выбери файлы с устройства. Перед загрузкой можно изменить их имена.</p>
              )}
              {rows.map((row) => (
                <section key={row.id} className="upload-row" aria-label={row.name}>
                  <label>
                    <span>Имя файла</span>
                    <input
                      value={row.name}
                      disabled={busy || row.started || row.status !== "queued"}
                      aria-label={`Имя: ${row.originalName}`}
                      onChange={(e) => {
                        try {
                          change(row.id, { name: e.target.value, replace: undefined });
                        } catch (err) {
                          setError(messageOf(err));
                        }
                      }}
                    />
                  </label>
                  <small>
                    {size(row.bytes)} · {row.folder || "Корень проекта"}
                    {row.replace ? " · Замена выбранной версии" : ""}
                  </small>
                  <progress
                    max={row.bytes || 1}
                    value={row.status === "done" ? row.bytes || 1 : row.offset}
                    aria-label={`Передача: ${row.name}`}
                  />
                  <p role="status">
                    {row.status === "done"
                      ? "Загружен"
                      : row.status === "cancelled"
                        ? "Пропущен"
                        : row.status === "committing"
                          ? "Сохранение на компьютер…"
                          : row.status === "uploading"
                            ? `${Math.round((row.offset / (row.bytes || 1)) * 100)}% · Передача на сервер`
                            : row.error || "Готов к загрузке"}
                  </p>
                  {row.status === "conflict" && row.conflict && (
                    <small>
                      {row.conflict.kind === "directory"
                        ? "Под этим именем уже есть папка."
                        : `На компьютере: ${size(row.conflict.size)} · Новый: ${size(row.bytes)}`}
                    </small>
                  )}
                  {row.status === "conflict" ? (
                    <div className="upload-conflict-actions">
                      <button
                        type="button"
                        className="secondary"
                        disabled={busy || row.conflict?.kind !== "file"}
                        onClick={() => void choose(row, true)}
                      >
                        Заменить старый
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        disabled={busy}
                        onClick={() => void choose(row, false)}
                      >
                        Другое имя
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        disabled={busy}
                        onClick={() => void cancelRow(row).catch((e) => setError(messageOf(e)))}
                      >
                        Пропустить
                      </button>
                    </div>
                  ) : (
                    !["done", "cancelled"].includes(row.status) && (
                      <div className="upload-row-actions">
                        {row.status === "error" && (
                          <button
                            type="button"
                            className="secondary"
                            disabled={busy}
                            onClick={() => void start(row.id)}
                          >
                            Продолжить / проверить
                          </button>
                        )}
                        {(!files.current.has(row.id) || row.status === "error") && (
                          <button
                            type="button"
                            className="secondary"
                            disabled={busy}
                            onClick={() => {
                              selectedAgain.current = row.id;
                              picker.current?.click();
                            }}
                          >
                            Выбрать снова
                          </button>
                        )}
                        <button
                          type="button"
                          className="secondary"
                          disabled={
                            row.status === "committing" || (busy && control.current?.id !== row.id)
                          }
                          onClick={() => {
                            if (control.current?.id === row.id) {
                              control.current.cancel = true;
                              control.current.abort.abort();
                            } else void cancelRow(row).catch((e) => setError(messageOf(e)));
                          }}
                        >
                          Отменить
                        </button>
                      </div>
                    )
                  )}
                </section>
              ))}
            </div>
          </dialog>,
          document.body,
        )}
    </>
  );
}
