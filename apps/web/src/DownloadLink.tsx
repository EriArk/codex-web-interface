import { isFileSource } from "@codex-web/shared";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { workspaceUrl } from "./accountStorage.ts";
import { FilePreview } from "./FilePreview";
import { FileViewerDialog } from "./FileViewerDialog";
import { Icon } from "./icons";
import { useWorkspaceDialog } from "./useWorkspaceDialog";
import { ViewerEditButton } from "./ViewerEditButton";
import "./download.css";

function standalone() {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

/** iOS may handle `download` in the PWA itself even with target=_blank.
 * Unsupported/large files explicitly leave saving to a separate browser context. */
function BrowserDownload({
  href,
  name,
  className = "secondary",
  children,
}: {
  href: string;
  name: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <a
      className={className}
      href={href}
      download={standalone() ? undefined : name}
      target="_blank"
      rel="noopener noreferrer"
    >
      {children}
    </a>
  );
}

export function isDownloadUrl(value: string | undefined): value is string {
  if (
    value &&
    /^\/api\/projects\/[a-zA-Z0-9_-]+\/file-archives\/[a-f0-9-]{36}\/content$/.test(value)
  )
    return true;
  if (value && /^\/api\/team\/brainstorm-conversions\/[a-zA-Z0-9_-]+\/export$/.test(value))
    return true;
  if (isFileSource(value)) return true;
  if (value && /^\/api\/threads\/[a-zA-Z0-9_-]+\/commands\/[^/?#]+\?[^#]+$/.test(value)) {
    const query = new URLSearchParams(value.split("?")[1]);
    return (
      query.size === 2 &&
      query.get("download") === "1" &&
      /^[a-zA-Z0-9_-]{1,200}$/.test(query.get("turnId") ?? "")
    );
  }
  if (value && /^\/api\/projects\/[a-zA-Z0-9_-]+\/files\/content\?[^#]+$/.test(value)) {
    const query = new URLSearchParams(value.split("?")[1]);
    return (
      query.size === 1 &&
      query.has("path") &&
      !!query.get("path") &&
      (query.get("path")?.length ?? 0) <= 2048
    );
  }
  return (
    !!value &&
    /^\/api\/(?:gpt\/projects\/[a-zA-Z0-9_-]+\/files\/[a-zA-Z0-9_-]+|gpt\/text-artifacts\/[a-f0-9]{64}|gpt\/native-assets\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+\/file[-_][a-zA-Z0-9_-]+|gpt\/(?:assets|results|uploads)\/[a-zA-Z0-9_-]+|gpt\/downloads\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+\/sandbox-[a-f0-9]{64}|(?:attachments|native-images|artifacts)\/[a-zA-Z0-9_-]+)$/.test(
      value,
    )
  );
}
function fileName(header: string | null, fallback: string, mime: string) {
  let name = fallback;
  const encoded = header?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  try {
    name = encoded
      ? decodeURIComponent(encoded)
      : header?.match(/filename="([^"]+)"/i)?.[1] || fallback;
  } catch {
    /* Keep the result title. */
  }
  name =
    name
      .replace(/./gs, (c) =>
        c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 || "\\/:".includes(c) ? "_" : c,
      )
      .slice(0, 180)
      .trim() || "Файл";
  const extension: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "application/pdf": "pdf",
    "text/plain": "txt",
    "application/json": "json",
  };
  if (!/\.[a-zA-Z0-9]{1,10}$/.test(name) && extension[mime]) name += "." + extension[mime];
  return name;
}
export function DownloadLink({
  href,
  name = "Файл",
  mime,
  children,
  className = "secondary",
  directDownload = false,
  onEdit,
  editLabel = "Редактировать",
  sourceRevision = 0,
  preparedFile,
  initiallyOpen = false,
}: {
  href?: string;
  /** Exact immutable local bytes, e.g. an editor snapshot or extracted archive entry. */
  preparedFile?: File;
  initiallyOpen?: boolean;
  name?: string;
  mime?: string;
  children: ReactNode;
  className?: string;
  directDownload?: boolean;
  /** Working-copy action, including explicit unlock. Other sources use the common copy editor. */
  onEdit?: (signal?: AbortSignal) => void | Promise<void>;
  editLabel?: string;
  sourceRevision?: number;
}) {
  const [open, setOpen] = useState(initiallyOpen),
    [file, setFile] = useState<File | null>(null),
    [objectUrl, setObjectUrl] = useState(""),
    [error, setError] = useState(""),
    [direct, setDirect] = useState<{ name: string; bytes: number } | null>(null),
    [retry, setRetry] = useState(0);
  const editRequest = useRef<AbortController | null>(null);
  const [editing, setEditing] = useState(false),
    [editError, setEditError] = useState("");
  // biome-ignore lint/correctness/useExhaustiveDependencies: Closing or changing source cancels this exact editor launch.
  useEffect(() => {
    setEditing(false);
    setEditError("");
    return () => {
      editRequest.current?.abort();
      editRequest.current = null;
    };
  }, [open, href, preparedFile]);
  useEffect(() => {
    const saved = (event: Event) => {
      if ((event as CustomEvent).detail?.source === href) setRetry((v) => v + 1);
    };
    window.addEventListener("workspace-file-saved", saved);
    return () => window.removeEventListener("workspace-file-saved", saved);
  }, [href]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry explicitly starts a fresh bounded download.
  useEffect(() => {
    if (!open && !preparedFile) {
      setFile(null);
      setObjectUrl("");
      setDirect(null);
      return;
    }
    const controller = new AbortController();
    let url = "";
    setFile(null);
    setObjectUrl("");
    setError("");
    setDirect(null);
    void (async () => {
      try {
        if (preparedFile) {
          url = URL.createObjectURL(new Blob([preparedFile], { type: "application/octet-stream" }));
          setObjectUrl(url);
          setFile(preparedFile);
          return;
        }
        if (!isDownloadUrl(href)) throw Error("Ссылка на файл недоступна.");
        if (/^\/api\/artifacts\/[a-zA-Z0-9_-]+$/.test(href)) {
          const head = await fetch(workspaceUrl(href), {
            method: "HEAD",
            credentials: "same-origin",
            redirect: "error",
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]),
          });
          if (!head.ok)
            throw Error(
              head.status === 401
                ? "Войди снова, чтобы скачать файл."
                : "Файл удалён или доступ к нему закрыт.",
            );
          const bytes = Number(head.headers.get("content-length"));
          if (bytes > 32 * 1024 * 1024) {
            if (!controller.signal.aborted)
              setDirect({
                name: fileName(head.headers.get("content-disposition"), name, mime || ""),
                bytes,
              });
            return;
          }
        }
        const response = await fetch(workspaceUrl(href), {
          credentials: "same-origin",
          redirect: "error",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60000)]),
        });
        if (!response.ok || !response.body)
          throw Error(
            response.status === 401
              ? "Войди снова, чтобы скачать файл."
              : "Не удалось получить файл. Попробуй ещё раз.",
          );
        const chunks: Uint8Array<ArrayBuffer>[] = [],
          reader = response.body.getReader();
        let size = 0;
        try {
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            size += part.value.length;
            if (size > 32 * 1024 * 1024) {
              if (!controller.signal.aborted)
                setDirect({
                  name: fileName(response.headers.get("content-disposition"), name, mime || ""),
                  bytes: Math.max(size, Number(response.headers.get("content-length")) || 0),
                });
              return;
            }
            chunks.push(new Uint8Array(part.value));
          }
        } finally {
          await reader.cancel();
        }
        const type =
          response.headers.get("content-type")?.split(";")[0] || mime || "application/octet-stream";
        const value = new File(
          chunks,
          fileName(response.headers.get("content-disposition"), name, type),
          { type },
        );
        if (controller.signal.aborted) return;
        // Never give executable HTML/SVG a same-origin blob document in fallback viewers.
        url = URL.createObjectURL(
          /^image\/(png|jpeg|gif|webp|avif)$/.test(type)
            ? value
            : new Blob([value], { type: "application/octet-stream" }),
        );
        setObjectUrl(url);
        setFile(value);
      } catch (e) {
        if (!controller.signal.aborted)
          setError(
            e instanceof TypeError || e instanceof DOMException
              ? "Не удалось загрузить файл. Проверь связь и повтори."
              : e instanceof Error
                ? e.message
                : "Файл недоступен.",
          );
      }
    })();
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [open, href, name, mime, retry, sourceRevision, preparedFile]);
  const shareable =
    !!file &&
    typeof navigator.share === "function" &&
    typeof navigator.canShare === "function" &&
    navigator.canShare({ files: [file] });
  const [sharing, setSharing] = useState(false);
  const shareRequest = useRef(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Invalidate the exact share when its source or window changes.
  useEffect(() => {
    shareRequest.current++;
    setSharing(false);
    return () => {
      shareRequest.current++;
    };
  }, [open, href, preparedFile]);
  const share = () => {
    if (!file || sharing) return;
    const request = ++shareRequest.current;
    setSharing(true);
    setError("");
    // Run directly in this fresh tap; a slow fetch must not consume iOS user activation.
    void navigator
      .share({ files: [file] })
      .catch((e) => {
        if (request === shareRequest.current && e?.name !== "AbortError")
          setError("Не удалось открыть меню сохранения. Попробуй ещё раз.");
      })
      .finally(() => {
        if (request === shareRequest.current) setSharing(false);
      });
  };
  // File-capable system sharing keeps standalone PWAs on their current screen.
  // Do not navigate to a raw attachment: iOS may replace the PWA with unclosable Quick Look.
  const systemSave =
    typeof navigator.share === "function" && typeof navigator.canShare === "function";
  const downloadHref = preparedFile ? objectUrl : isDownloadUrl(href) ? workspaceUrl(href) : "";
  if (directDownload && !systemSave && !initiallyOpen && !standalone())
    return downloadHref ? (
      <BrowserDownload className={className} href={downloadHref} name={preparedFile?.name || name}>
        {children}
      </BrowserDownload>
    ) : null;
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)}>
        {children}
      </button>
      {open && directDownload ? (
        <SaveDialog name={direct?.name || file?.name || name} onClose={() => setOpen(false)}>
          {!file && !direct && !error && (
            <p role="status">
              <span className="spinner" /> Подготавливаю файл…
            </p>
          )}
          {file && shareable ? (
            <button type="button" className="secondary" disabled={sharing} onClick={share}>
              Сохранить / поделиться
            </button>
          ) : (file || direct) && downloadHref ? (
            <BrowserDownload href={downloadHref} name={direct?.name || file?.name || name}>
              Скачать через браузер
            </BrowserDownload>
          ) : null}
          {error && <p role="alert">{error}</p>}
          {error && (
            <button type="button" className="secondary" onClick={() => setRetry((v) => v + 1)}>
              Повторить
            </button>
          )}
        </SaveDialog>
      ) : (
        open && (
          <FileViewerDialog
            name={direct?.name || file?.name || name}
            file={file}
            source={href}
            editProvided={!!onEdit}
            onClose={() => setOpen(false)}
            actions={
              <>
                {onEdit && (
                  <button
                    type="button"
                    className="secondary"
                    disabled={editing}
                    onClick={async () => {
                      if (editRequest.current) return;
                      const controller = new AbortController();
                      editRequest.current = controller;
                      setEditing(true);
                      setEditError("");
                      try {
                        await onEdit(controller.signal);
                      } catch (e) {
                        if (!controller.signal.aborted)
                          setEditError(
                            e instanceof Error ? e.message : "Не удалось открыть редактор.",
                          );
                      } finally {
                        if (!controller.signal.aborted) {
                          editRequest.current = null;
                          setEditing(false);
                        }
                      }
                    }}
                  >
                    {editing ? "Открываю редактор…" : editLabel}
                  </button>
                )}
                {file && shareable ? (
                  <button type="button" className="secondary" disabled={sharing} onClick={share}>
                    Сохранить / поделиться
                  </button>
                ) : downloadHref ? (
                  <BrowserDownload href={downloadHref} name={file?.name || name}>
                    Скачать файл
                  </BrowserDownload>
                ) : null}
              </>
            }
          >
            {!file && !direct && !error && (
              <p role="status">
                <span className="spinner" /> Подготавливаю файл…
              </p>
            )}
            {file && (
              <FilePreview
                key={file.name + retry}
                file={file}
                objectUrl={objectUrl}
                source={href}
                full
              />
            )}
            {direct && (
              <div className="download-actions">
                <ViewerEditButton name={direct.name} source={href} />
                <p>
                  {new Intl.NumberFormat("ru", { maximumFractionDigits: 1 }).format(
                    direct.bytes / 1024 / 1024,
                  )}{" "}
                  МБ · Сохранение через загрузки браузера
                </p>
                <BrowserDownload href={workspaceUrl(href!)} name={direct.name}>
                  Скачать файл
                </BrowserDownload>
              </div>
            )}
            {error && <p role="alert">{error}</p>}
            {editError && <p role="alert">{editError}</p>}
            {error && (
              <button type="button" onClick={() => setRetry((v) => v + 1)}>
                Повторить
              </button>
            )}
          </FileViewerDialog>
        )
      )}
    </>
  );
}

/** A save action stays separate from the full viewer and preserves the mounted source feed. */
function SaveDialog({
  name,
  onClose,
  children,
}: {
  name: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useWorkspaceDialog(dialog);
  return createPortal(
    <dialog
      ref={dialog}
      className="workspace-window result-save-dialog"
      aria-label="Сохранить файл"
      tabIndex={-1}
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
    >
      <header>
        <div>
          <strong>Сохранить файл</strong>
          <p title={name}>{name}</p>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="Закрыть сохранение"
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </header>
      <div className="result-save-body">{children}</div>
    </dialog>,
    document.body,
  );
}
