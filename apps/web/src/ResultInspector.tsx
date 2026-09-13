import { useEffect, useState } from "react";
import { workspaceMediaUrl, workspaceUrl } from "./accountStorage.ts";
import { CopyButton } from "./CopyButton";
import { DownloadLink, isDownloadUrl } from "./DownloadLink";
import { Icon } from "./icons";
import { PreviewViewer } from "./PreviewViewer";
import type { Result } from "./types";

function TextFile({ result }: { result: Result }) {
  const [text, setText] = useState<string | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    const path = result.payload.url ?? "";
    if (!isDownloadUrl(path)) {
      setError("Для просмотра скачай файл.");
      return;
    }
    void (async () => {
      try {
        const response = await fetch(workspaceUrl(path), {
          credentials: "same-origin",
          signal: controller.signal,
        });
        if (!response.ok || !response.body) throw Error();
        const reader = response.body.getReader(),
          chunks: Uint8Array[] = [];
        let size = 0;
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.length;
            if (size > 128 * 1024) throw Error("large");
            chunks.push(chunk.value);
          }
        } finally {
          await reader.cancel();
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        if (!controller.signal.aborted) setText(value);
      } catch {
        if (!controller.signal.aborted) setError("Для просмотра скачай файл.");
      }
    })();
    return () => controller.abort();
  }, [result.payload.url]);
  return (
    <>
      {error ? (
        <p>{error}</p>
      ) : (
        <>
          <CopyButton text={text ?? ""} label="Копировать файл" />
          <pre>{text ?? "Загружаем…"}</pre>
        </>
      )}
    </>
  );
}
export function ResultInspector({
  result,
  onClose,
  onExpand,
}: {
  result: Result;
  onClose: () => void;
  onExpand: () => void;
}) {
  return (
    <div className="result-inspector">
      <div className="result-inspector-heading">
        <button
          type="button"
          className="icon-button"
          onClick={onClose}
          aria-label="Вернуться к результатам"
        >
          <Icon name="back" />
        </button>
        <strong>{result.title}</strong>
        {(result.type === "image" || result.type === "preview") && (
          <button
            type="button"
            className="icon-button"
            onClick={onExpand}
            aria-label="Развернуть предпросмотр"
          >
            <Icon name="expand" />
          </button>
        )}
      </div>
      {result.type === "preview" ? (
        <PreviewViewer key={result.id} result={result} onClose={onClose} embedded />
      ) : result.type === "image" ? (
        <>
          <img
            className="result-inspector-image"
            src={workspaceMediaUrl(result.payload.url)}
            alt={result.title}
          />
          <DownloadLink className="secondary" href={result.payload.url} name={result.title}>
            Скачать
          </DownloadLink>
        </>
      ) : (
        <div className="result-inspector-file">
          <Icon name="file" size={30} />
          {/^text\//.test(result.payload.mime ?? "") && (
            <TextFile key={result.id} result={result} />
          )}
          <DownloadLink className="secondary" href={result.payload.url} name={result.title}>
            Скачать файл
          </DownloadLink>
        </div>
      )}
    </div>
  );
}
