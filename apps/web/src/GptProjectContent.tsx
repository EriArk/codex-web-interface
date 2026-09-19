import type { GptNativeProject, GptProjectOperation } from "@codex-web/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { accountLocalStorage as localStorage } from "./accountStorage.ts";
import { ApiError, api, messageOf } from "./api";
import { DownloadLink } from "./DownloadLink";
import { Icon } from "./icons";
import { uploadFile } from "./uploadFile";
import "./quick-capture.css";

type Mutation = {
  projectId: string;
  revision: string;
  action: "instructions" | "upload" | "remove";
  text?: string;
  uploadId?: string;
  fileId?: string;
  confirm?: true;
};
type Receipt = { id: string; body: Mutation };
const pending = (o: GptProjectOperation) => o.state === "pending" || o.state === "unknown";
export function GptProjectContent({
  projectId,
  onClose,
}: {
  projectId: string;
  onClose: () => void;
}) {
  const key = "gpt-project-draft:" + projectId,
    receiptKey = key + ":receipt";
  const [project, setProject] = useState<GptNativeProject | null>(null),
    [operations, setOperations] = useState<GptProjectOperation[]>([]),
    [text, setText] = useState(() => localStorage.getItem(key) ?? ""),
    [receipt, setReceipt] = useState<Receipt | null>(() => {
      try {
        return JSON.parse(localStorage.getItem(receiptKey) ?? "null");
      } catch {
        return null;
      }
    }),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [baseRevision, setBaseRevision] = useState(
    () => localStorage.getItem(key + ":revision") ?? "",
  );
  const dialog = useRef<HTMLDialogElement>(null),
    alive = useRef(true),
    editing = useRef(localStorage.getItem(key) !== null),
    sending = useRef(false),
    input = useRef<HTMLInputElement>(null);
  const refresh = useCallback(
    async (rebase = false) => {
      const result = await api<{ project: GptNativeProject; operations: GptProjectOperation[] }>(
        `/gpt/projects/${encodeURIComponent(projectId)}/content`,
      );
      if (!alive.current) return;
      setError("");
      setProject(result.project);
      setOperations(result.operations);
      if (rebase) {
        setBaseRevision(result.project.revision);
        localStorage.setItem(key + ":revision", result.project.revision);
      }
      if (!editing.current) setText(result.project.instructions);
      const stored = localStorage.getItem(receiptKey);
      let sent: Receipt | null = null;
      try {
        sent = JSON.parse(stored ?? "null");
      } catch {}
      const op = sent && result.operations.find((o) => o.id === sent.id);
      if (op && !pending(op)) {
        localStorage.removeItem(receiptKey);
        setReceipt(null);
        if (
          op.state === "completed" &&
          sent?.body.action === "instructions" &&
          localStorage.getItem(key) === sent.body.text
        ) {
          localStorage.removeItem(key);
          editing.current = false;
          setText(result.project.instructions);
        }
      }
      return result.operations.some(pending);
    },
    [projectId, key, receiptKey],
  );
  useEffect(() => {
    alive.current = true;
    const focus = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    dialog.current?.focus({ preventScroll: true });
    let loading = false,
      nextPoll = 0;
    const poll = async () => {
      if (loading || document.hidden || Date.now() < nextPoll) return;
      loading = true;
      try {
        const active = await refresh();
        nextPoll = Date.now() + (active ? 2500 : 30000);
      } catch (e) {
        if (alive.current) setError(messageOf(e));
      } finally {
        loading = false;
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 2500);
    return () => {
      alive.current = false;
      clearInterval(timer);
      dialog.current?.close();
      focus?.focus({ preventScroll: true });
    };
  }, [refresh]);
  const submit = async (body?: Mutation) => {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setError("");
    const value = body ? { id: crypto.randomUUID(), body } : receipt;
    try {
      if (!value) return;
      localStorage.setItem(receiptKey, JSON.stringify(value));
      setReceipt(value);
      await api("/gpt/project-operations", { method: "POST", key: value.id, body: value.body });
      await refresh();
    } catch (e) {
      if (alive.current) {
        setError(messageOf(e));
        if (e instanceof ApiError && e.status >= 400 && e.status < 500) {
          localStorage.removeItem(receiptKey);
          setReceipt(null);
        }
      }
      await refresh().catch(() => {});
    } finally {
      sending.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const upload = async (file: File) => {
    if (!project || sending.current) return;
    sending.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await uploadFile<{ id: string }>(file, { kind: "gpt" });
      if (alive.current) {
        sending.current = false;
        await submit({
          projectId,
          revision: project.revision,
          action: "upload",
          uploadId: result.file.id,
        });
      }
    } catch (e) {
      if (alive.current) setError(messageOf(e));
    } finally {
      sending.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const check = async (op: GptProjectOperation, checked = false) => {
    setBusy(true);
    setError("");
    try {
      await api(`/gpt/project-operations/${op.id}/${checked ? "checked" : "check"}`, {
        method: "POST",
        body: checked ? { confirm: true } : {},
      });
      await refresh();
    } catch (e) {
      if (alive.current) setError(messageOf(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const blocked = busy || !!receipt || operations.some(pending) || !project?.canWrite;
  return createPortal(
    <dialog
      ref={dialog}
      className="quick-capture-dialog gpt-project-content"
      tabIndex={-1}
      aria-label="Инструкции и файлы ChatGPT"
      onCancel={onClose}
    >
      <header>
        <Icon name="folder" />
        <h2>Проект в ChatGPT</h2>
        <button
          type="button"
          className="icon-button"
          aria-label="Закрыть проект ChatGPT"
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </header>
      <div className="quick-capture-content">
        {project ? (
          <>
            <h3>{project.name}</h3>
            <p>
              Эти инструкции и источники используются самим ChatGPT во всех чатах проекта. «Основа
              проекта» хранится отдельно.
            </p>
            <label>
              Инструкции
              <textarea
                aria-label="Инструкции проекта ChatGPT"
                value={text}
                maxLength={100000}
                disabled={blocked}
                onChange={(e) => {
                  if (!editing.current) {
                    setBaseRevision(project.revision);
                    localStorage.setItem(key + ":revision", project.revision);
                  }
                  editing.current = true;
                  setText(e.target.value);
                  try {
                    localStorage.setItem(key, e.target.value);
                  } catch {}
                }}
              />
            </label>
            <div className="gpt-project-actions">
              <button
                type="button"
                className="primary"
                disabled={blocked || text === project.instructions}
                onClick={() =>
                  void submit({
                    projectId,
                    revision: baseRevision || project.revision,
                    action: "instructions",
                    text,
                  })
                }
              >
                Сохранить инструкции
              </button>
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void refresh(true)
                    .catch((e) => setError(messageOf(e)))
                    .finally(() => {
                      if (alive.current) setBusy(false);
                    });
                }}
              >
                <Icon name="refresh" /> Обновить
              </button>
            </div>
            <h3>Файлы · {project.files.length}</h3>
            {!project.files.length && <p>В проекте пока нет файлов.</p>}
            {project.files.map((file) => (
              <div className="gpt-project-file" key={file.id}>
                <DownloadLink
                  href={`/api/gpt/projects/${projectId}/files/${file.id}`}
                  name={file.name}
                >
                  {file.name}
                </DownloadLink>
                <small>
                  {file.bytes === null ? "Размер неизвестен" : `${Math.ceil(file.bytes / 1024)} КБ`}
                </small>
                <button
                  type="button"
                  className="icon-button danger"
                  disabled={blocked}
                  aria-label={`Удалить ${file.name} из ChatGPT`}
                  onClick={() => {
                    if (
                      window.confirm(
                        `Удалить «${file.name}» из проекта ChatGPT? Это нативное удаление источника.`,
                      )
                    )
                      void submit({
                        projectId,
                        revision: project.revision,
                        action: "remove",
                        fileId: file.id,
                        confirm: true,
                      });
                  }}
                >
                  <Icon name="trash" />
                </button>
              </div>
            ))}
            <input
              ref={input}
              type="file"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) void upload(file);
              }}
            />
            <button
              type="button"
              className="secondary"
              disabled={blocked}
              onClick={() => input.current?.click()}
            >
              <Icon name="file" /> Добавить файл
            </button>
            {!project.canWrite && <p>ChatGPT разрешает только просмотр этого проекта.</p>}
          </>
        ) : (
          <p role="status">Загружаем проект…</p>
        )}
        {receipt && !operations.some((o) => o.id === receipt.id) && (
          <button type="button" className="secondary" disabled={busy} onClick={() => void submit()}>
            Проверить отправленное действие
          </button>
        )}
        {operations
          .filter((op, index) => pending(op) || index === 0)
          .map((op) => (
            <div className="notice" role="status" key={op.id}>
              <p>
                {op.state === "completed"
                  ? "Изменение подтверждено ChatGPT."
                  : op.state === "checked"
                    ? "Результат отмечен проверенным."
                    : op.error || "Применяем изменение…"}
              </p>
              {op.state === "unknown" && (
                <>
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() => void check(op)}
                  >
                    Проверить результат
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() => {
                      if (
                        window.confirm(
                          "Ты проверил проект в ChatGPT? Действие не будет отправлено повторно.",
                        )
                      )
                        void check(op, true);
                    }}
                  >
                    Проверено вручную
                  </button>
                </>
              )}
            </div>
          ))}
        {error && <p role="alert">{error}</p>}
        <a href={`https://chatgpt.com/g/${projectId}/project`} target="_blank" rel="noreferrer">
          Открыть проект в ChatGPT
        </a>
      </div>
    </dialog>,
    document.body,
  );
}
export function GptProjectButton({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="secondary" onClick={() => setOpen(true)}>
        <Icon name="folder" /> Инструкции и файлы ChatGPT
      </button>
      {open && (
        <GptProjectContent key={projectId} projectId={projectId} onClose={() => setOpen(false)} />
      )}
    </>
  );
}
export function GptProjectPending() {
  const [items, setItems] = useState<GptProjectOperation[]>([]),
    [selected, setSelected] = useState("");
  useEffect(() => {
    let alive = true,
      loading = false;
    const poll = async () => {
      if (loading || document.hidden) return;
      loading = true;
      try {
        const r = await api<{ items: GptProjectOperation[] }>("/gpt/project-operations");
        if (alive) setItems(r.items);
      } catch {
      } finally {
        loading = false;
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 3000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  return (
    <>
      {items.map((item) => (
        <div className="notice" key={item.id}>
          Изменение проекта ChatGPT{" "}
          {item.state === "unknown" ? "требует проверки." : "выполняется."}
          <button type="button" className="secondary" onClick={() => setSelected(item.projectId)}>
            Открыть проект
          </button>
        </div>
      ))}
      {selected && (
        <GptProjectContent key={selected} projectId={selected} onClose={() => setSelected("")} />
      )}
    </>
  );
}
