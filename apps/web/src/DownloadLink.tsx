import { isFileSource } from "@codex-web/shared";
import { type ReactNode, useEffect, useState } from "react";
import { workspaceUrl } from "./accountStorage.ts";
import { FilePreview } from "./FilePreview";
import { FileViewerDialog } from "./FileViewerDialog";
import "./download.css";

export function isDownloadUrl(value: string | undefined): value is string {
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
  sourceRevision = 0,
}: {
  href?: string;
  name?: string;
  mime?: string;
  children: ReactNode;
  className?: string;
  directDownload?: boolean;
  /** Only supplied by the unlocked, exact working-copy owner. Saved artifacts are immutable. */
  onEdit?: () => void;
  sourceRevision?: number;
}) {
  const [open, setOpen] = useState(false),
    [file, setFile] = useState<File | null>(null),
    [objectUrl, setObjectUrl] = useState(""),
    [error, setError] = useState(""),
    [direct, setDirect] = useState<{ name: string; bytes: number } | null>(null),
    [retry, setRetry] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry explicitly starts a fresh bounded download.
  useEffect(() => {
    if (!open) {
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
            if (size > 32 * 1024 * 1024) throw Error("Файл превышает 32 МБ.");
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
  }, [open, href, name, mime, retry, sourceRevision]);
  const shareable =
    !!file &&
    typeof navigator.share === "function" &&
    typeof navigator.canShare === "function" &&
    navigator.canShare({ files: [file] });
  const share = () => {
    if (!file) return;
    setError("");
    // Run directly in this fresh tap; a slow fetch must not consume iOS user activation.
    void navigator.share({ files: [file] }).catch((e) => {
      if (e?.name !== "AbortError")
        setError("Не удалось открыть меню сохранения. Попробуй ещё раз.");
    });
  };
  if (directDownload)
    return isDownloadUrl(href) ? (
      <a
        className={className}
        href={workspaceUrl(href)}
        download={name}
        target="_blank"
        rel="noopener noreferrer"
      >
        {children}
      </a>
    ) : null;
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)}>
        {children}
      </button>
      {open && (
        <FileViewerDialog
          name={direct?.name || file?.name || name}
          file={file}
          source={href}
          onClose={() => setOpen(false)}
          actions={
            <>
              {onEdit && (
                <button type="button" className="secondary" onClick={onEdit}>
                  Редактировать
                </button>
              )}
              {file && shareable ? (
                <button type="button" onClick={share}>
                  Сохранить / поделиться
                </button>
              ) : isDownloadUrl(href) ? (
                <a
                  className="secondary"
                  href={workspaceUrl(href)}
                  download={file?.name || name}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Скачать файл
                </a>
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
              <p>
                {new Intl.NumberFormat("ru", { maximumFractionDigits: 1 }).format(
                  direct.bytes / 1024 / 1024,
                )}{" "}
                МБ · Сохранение через загрузки браузера
              </p>
              <a
                className="secondary"
                href={workspaceUrl(href!)}
                download={direct.name}
                target="_blank"
                rel="noopener noreferrer"
              >
                Скачать файл
              </a>
            </div>
          )}
          {error && <p role="alert">{error}</p>}
          {error && (
            <button type="button" onClick={() => setRetry((v) => v + 1)}>
              Повторить
            </button>
          )}
        </FileViewerDialog>
      )}
    </>
  );
}
