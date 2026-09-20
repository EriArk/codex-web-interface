import { useState } from "react";
import { ArtifactCapture } from "./ArtifactCapture";
import CanvasPanel from "./CanvasPanel";
import { DownloadLink } from "./DownloadLink";
import { Icon } from "./icons";
import { PreviewViewer } from "./PreviewViewer";
import { ResultFilePreview } from "./ResultFilePreview";
import { resultPreview } from "./resultPreview";
import type { Result } from "./types";

export function ResultInspector({
  result,
  onClose,
  onExpand,
  onRetry,
  initialPreview = false,
}: {
  result: Result;
  onClose: () => void;
  onExpand: () => void;
  onRetry?: () => void;
  initialPreview?: boolean;
}) {
  const [opened, setOpened] = useState(initialPreview);
  const { kind } = resultPreview(result);
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
        {opened && (result.type === "image" || result.type === "preview") && (
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
      <div className="result-artifact-actions">
        {kind !== "card" && !opened && (
          <button type="button" className="secondary" onClick={() => setOpened(true)}>
            Предпросмотр
          </button>
        )}
        {result.payload.url && result.type !== "preview" && (
          <DownloadLink directDownload href={result.payload.url} name={result.title}>
            Скачать файл
          </DownloadLink>
        )}
      </div>
      {result.payload.bytes !== undefined && (
        <small className="muted">
          {new Intl.NumberFormat("ru", { maximumFractionDigits: 1 }).format(
            result.payload.bytes / 1024,
          )}{" "}
          КБ
        </small>
      )}
      {result.payload.message && <p role="status">{result.payload.message}</p>}
      {!opened && result.payload.excerpt && (
        <pre className="result-text-excerpt">{result.payload.excerpt}</pre>
      )}
      {result.payload.captureId && !result.payload.url && (
        <ArtifactCapture
          id={result.payload.captureId}
          status={result.payload.status || "failed"}
          message={result.payload.message}
          onComplete={onRetry}
        />
      )}
      {opened &&
        (kind === "canvas" && result.payload.canvas ? (
          <CanvasPanel
            conversationId={result.payload.canvas.conversationId}
            documentId={result.payload.canvas.id}
            onClose={() => setOpened(false)}
          />
        ) : kind === "demo" ? (
          <PreviewViewer result={result} onClose={onClose} embedded />
        ) : kind !== "card" ? (
          <ResultFilePreview result={result} />
        ) : null)}
    </div>
  );
}
