import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { workspaceUrl } from "./accountStorage.ts";
import { FilePreview } from "./FilePreview";
import { Icon } from "./icons";
import "./download.css";

export function isDownloadUrl(value: string | undefined): value is string {
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
    /^\/api\/(?:gpt\/projects\/[a-zA-Z0-9_-]+\/files\/[a-zA-Z0-9_-]+|gpt\/(?:assets|results|uploads)\/[a-zA-Z0-9_-]+|gpt\/downloads\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+\/sandbox-[a-f0-9]{64}|(?:attachments|native-images|artifacts)\/[a-zA-Z0-9_-]+)$/.test(
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
}: {
  href?: string;
  name?: string;
  mime?: string;
  children: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false),
    [file, setFile] = useState<File | null>(null),
    [objectUrl, setObjectUrl] = useState(""),
    [error, setError] = useState(""),
    [retry, setRetry] = useState(0);
  const dialog = useRef<HTMLDialogElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry explicitly starts a fresh bounded download.
  useEffect(() => {
    if (!open) {
      setFile(null);
      setObjectUrl("");
      return;
    }
    const controller = new AbortController();
    let url = "";
    setFile(null);
    setObjectUrl("");
    setError("");
    dialog.current?.showModal();
    dialog.current?.focus({ preventScroll: true });
    void (async () => {
      try {
        if (!isDownloadUrl(href)) throw Error("Ссылка на файл недоступна.");
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
  }, [open, href, name, mime, retry]);
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
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)}>
        {children}
      </button>
      {open &&
        createPortal(
          <dialog
            ref={dialog}
            className="download-dialog"
            tabIndex={-1}
            aria-label="Сохранить файл"
            onCancel={() => setOpen(false)}
          >
            <div className="download-heading">
              <strong>{file?.name || name}</strong>
              <button
                type="button"
                className="icon-button"
                aria-label="Закрыть сохранение"
                onClick={() => setOpen(false)}
              >
                <Icon name="close" />
              </button>
            </div>
            {!file && !error && (
              <p role="status">
                <span className="spinner" /> Подготавливаю файл…
              </p>
            )}
            {file && <FilePreview key={file.name + retry} file={file} objectUrl={objectUrl} />}
            {error && <p role="alert">{error}</p>}
            {file ? (
              <div className="download-actions">
                {shareable ? (
                  <button type="button" onClick={share}>
                    Сохранить / поделиться
                  </button>
                ) : (
                  <a
                    className="secondary"
                    href={objectUrl}
                    download={file.name}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Скачать файл
                  </a>
                )}
              </div>
            ) : (
              error && (
                <button type="button" onClick={() => setRetry((v) => v + 1)}>
                  Повторить
                </button>
              )
            )}
          </dialog>,
          document.body,
        )}
    </>
  );
}
