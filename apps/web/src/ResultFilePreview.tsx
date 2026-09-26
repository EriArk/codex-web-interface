import { useEffect, useState } from "react";
import { workspaceUrl } from "./accountStorage";
import { DownloadLink, isDownloadUrl } from "./DownloadLink";
import { FilePreview } from "./FilePreview";
import { FileViewerDialog } from "./FileViewerDialog";
import { ResultShareButton } from "./ResultSharing";
import { resultPreview } from "./resultPreview";
import type { Result } from "./types";

/** Full viewers are mounted only when a file/image is opened. */
export function ResultFilePreview({ result, onClose }: { result: Result; onClose: () => void }) {
  const path = result.payload.url,
    mime = result.payload.mime,
    title = result.title;
  const { kind, limit } = resultPreview(result);
  const [file, setFile] = useState<File | null>(null),
    [url, setUrl] = useState(""),
    [error, setError] = useState(""),
    [truncated, setTruncated] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const saved = (event: Event) => {
      if ((event as CustomEvent).detail?.source === path) setRevision((v) => v + 1);
    };
    window.addEventListener("workspace-file-saved", saved);
    return () => window.removeEventListener("workspace-file-saved", saved);
  }, [path]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: An exact working-source save refreshes the viewer bytes.
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
  }, [path, mime, title, kind, limit, revision]);
  return (
    <FileViewerDialog
      name={title}
      file={file}
      source={path}
      onClose={onClose}
      actions={
        <>
          <ResultShareButton result={result} />
          {isDownloadUrl(path) ? (
            <DownloadLink href={path} name={title} mime={mime} directDownload>
              Скачать файл
            </DownloadLink>
          ) : null}
        </>
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
