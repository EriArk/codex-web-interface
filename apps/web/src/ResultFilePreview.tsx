import { useEffect, useState } from "react";
import { workspaceUrl } from "./accountStorage";
import { isDownloadUrl } from "./DownloadLink";
import { FilePreview } from "./FilePreview";
import { FileViewerDialog } from "./FileViewerDialog";
import { resultPreview } from "./resultPreview";
import type { Result } from "./types";

/** Full viewers are mounted only by an explicit Preview action. */
export function ResultFilePreview({ result, onClose }: { result: Result; onClose: () => void }) {
  const path = result.payload.url,
    mime = result.payload.mime,
    title = result.title;
  const { kind, limit } = resultPreview(result);
  const [file, setFile] = useState<File | null>(null),
    [url, setUrl] = useState(""),
    [error, setError] = useState(""),
    [truncated, setTruncated] = useState(false);
  useEffect(() => {
    setFile(null);
    setUrl("");
    setError("");
    setTruncated(false);
    const controller = new AbortController();
    let resource = "";
    void (async () => {
      if (!isDownloadUrl(path)) throw Error();
      if (!limit || kind === "card") throw Error();
      const response = await fetch(workspaceUrl(path), {
        credentials: "same-origin",
        redirect: "error",
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]),
      });
      if (!response.ok || !response.body) throw Error();
      const reader = response.body.getReader(),
        chunks: Uint8Array<ArrayBuffer>[] = [];
      let size = 0,
        cut = false;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          const remaining = limit - size;
          if (value.length > remaining) {
            if (kind !== "text") throw Error();
            chunks.push(new Uint8Array(value.subarray(0, remaining)));
            cut = true;
            break;
          }
          size += value.length;
          chunks.push(new Uint8Array(value));
        }
      } finally {
        await reader.cancel();
      }
      if (controller.signal.aborted) return;
      const type =
        mime || response.headers.get("content-type")?.split(";")[0] || "application/octet-stream";
      const value = new File(chunks, title, { type });
      resource = URL.createObjectURL(
        new Blob([value], { type: kind === "image" ? type : "application/octet-stream" }),
      );
      setFile(value);
      setUrl(resource);
      setTruncated(cut);
    })().catch(() => {
      if (!controller.signal.aborted)
        setError("Предпросмотр недоступен. Можно скачать исходный файл.");
    });
    return () => {
      controller.abort();
      if (resource) URL.revokeObjectURL(resource);
    };
  }, [path, mime, title, kind, limit]);
  return (
    <FileViewerDialog
      name={title}
      file={file}
      source={path}
      onClose={onClose}
      actions={
        isDownloadUrl(path) ? (
          <a
            className="secondary"
            href={workspaceUrl(path)}
            download={title}
            target="_blank"
            rel="noopener noreferrer"
          >
            Скачать файл
          </a>
        ) : null
      }
    >
      {error ? (
        <p role="status">{error}</p>
      ) : file ? (
        <>
          <FilePreview file={file} objectUrl={url} source={path} full />
          {truncated && (
            <small>Показано начало файла. Полная версия доступна для скачивания.</small>
          )}
        </>
      ) : (
        <p role="status">Загружаем предпросмотр…</p>
      )}
    </FileViewerDialog>
  );
}
