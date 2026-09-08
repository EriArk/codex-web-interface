import type { ResultItem } from "@codex-web/shared";
import {
  emptyResultCounts,
  type ResultCategory,
  type ResultCounts,
  resultCategory,
} from "@codex-web/shared";
import { ArtifactCapture } from "./ArtifactCapture";
import { DownloadLink } from "./DownloadLink";
import { ResultFilters } from "./ResultFilters";
import { ResultInspector } from "./ResultInspector";
import "./resultCategories.css";
import { type ReactNode, useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CollapsibleCode } from "./CollapsibleCode";
import { CopyButton } from "./CopyButton";
import { Icon } from "./icons";
import { PreviewViewer } from "./PreviewViewer";
import type { Activity, Result } from "./types";
export function Results({
  focusVersion = 0,
  onRetry,
  category = "all",
  onCategory = () => {},
  counts = emptyResultCounts(),
  error = "",
  onOverlayChange,
  results,
  visible,
  focusId,
  busy,
  hasMore,
  onOlder,
  onTurn,
  toolbar,
  onFile,
  onSaveLink,
}: {
  focusVersion?: number;
  onRetry?: () => void;
  category?: ResultCategory;
  onCategory?: (category: ResultCategory) => void;
  counts?: ResultCounts;
  error?: string;
  onOverlayChange: (open: boolean) => void;
  results: Result[];
  visible: boolean;
  focusId: string;
  busy: boolean;
  hasMore: boolean;
  onOlder: () => void;
  onTurn?: (id: string, threadId?: string) => void;
  toolbar?: ReactNode;
  onFile?: (path: string) => void;
  onSaveLink?: (result: ResultItem) => void;
}) {
  const ref = useRef<HTMLDivElement>(null),
    [image, setImage] = useState<Result | null>(null),
    [preview, setPreview] = useState<Result | null>(null),
    [inspected, setInspected] = useState<Result | null>(null),
    [inspecting, setInspecting] = useState(false);
  useEffect(() => {
    onOverlayChange(!!image || !!preview);
    return () => onOverlayChange(false);
  }, [image, preview, onOverlayChange]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Newly loaded result cards must be focused after rendering.
  useEffect(() => {
    if (visible && focusId)
      requestAnimationFrame(() =>
        ref.current
          ?.querySelector(`[data-result="${CSS.escape(focusId)}"]`)
          ?.scrollIntoView({ block: "center" }),
      );
  }, [focusId, visible, results]);
  const inspect = (result: Result) => {
    setInspected(result);
    setInspecting(true);
  };
  useEffect(() => {
    if (focusId || focusVersion) setInspecting(false);
  }, [focusId, focusVersion]);
  return (
    <section className="results-pane pane" data-visible={visible} aria-label="Результаты">
      <div className="pane-heading">
        <span>
          <Icon name="results" />
          Результаты
        </span>
        {counts.all > 0 && <span className="small muted">{counts.all}</span>}
      </div>
      {toolbar}
      <ResultFilters
        category={category}
        counts={counts}
        preview={inspecting}
        onChange={(next) => {
          setInspecting(false);
          onCategory(next);
        }}
        onPreview={inspected ? () => setInspecting(true) : undefined}
      />
      {error && (
        <div className="results-error" role="status">
          {error}
          {onRetry && (
            <button type="button" className="secondary" onClick={onRetry}>
              Повторить
            </button>
          )}
        </div>
      )}
      <div className="result-preview-slot" hidden={!inspecting}>
        {inspected && (
          <ResultInspector
            result={inspected}
            onClose={() => setInspecting(false)}
            onExpand={() =>
              inspected.type === "image" ? setImage(inspected) : setPreview(inspected)
            }
          />
        )}
      </div>
      <div className="pane-scroll" ref={ref} hidden={inspecting}>
        {!results.some((r) => category === "all" || resultCategory(r.type) === category) && (
          <div className="empty-state">
            <div className="empty-symbol">
              <Icon name="results" size={29} />
            </div>
            <h2>{busy ? "Загружаем…" : "Пока нет результатов."}</h2>
          </div>
        )}
        {results
          .filter((r) => category === "all" || resultCategory(r.type) === category)
          .map((r) => (
            <article className={`result-card result-${r.type}`} key={r.id} data-result={r.id}>
              <div className="result-title">
                {onSaveLink && (
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Сохранить ссылку: ${r.title}`}
                    onClick={() => onSaveLink(r)}
                  >
                    <Icon name="pin" size={16} />
                  </button>
                )}
                <span className="result-icon">
                  <Icon
                    name={r.type === "image" ? "image" : r.type === "check" ? "check" : "folder"}
                  />
                </span>
                <div>
                  <h3>{r.title}</h3>
                  <time>
                    {new Date(r.payload.capturedAt || r.createdAt).toLocaleString("ru", {
                      day: "numeric",
                      month: "short",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </time>
                </div>
                {r.type === "check" && (
                  <span className={`badge ${r.payload.exitCode === 0 ? "success" : "danger"}`}>
                    {r.payload.exitCode === 0 ? "Успешно" : "Ошибка"}
                  </span>
                )}
              </div>
              {r.type === "image" && r.payload.url && (
                <button
                  type="button"
                  className="screenshot-preview"
                  onClick={() => inspect(r)}
                  aria-label="Открыть снимок"
                >
                  <img
                    src={r.payload.url}
                    loading="lazy"
                    alt={r.title}
                    width={r.payload.width}
                    height={r.payload.height}
                  />
                </button>
              )}
              {r.type === "preview" && (
                <button
                  type="button"
                  className="secondary result-demo-open"
                  onClick={() => inspect(r)}
                >
                  <Icon name="remote" /> Открыть демо <Icon name="chevron" size={16} />
                </button>
              )}
              {(r.type === "file" || r.type === "artifact") && r.payload.url && (
                <button
                  type="button"
                  className="secondary result-file-link"
                  onClick={() => inspect(r)}
                >
                  <Icon name="file" /> Открыть файл
                </button>
              )}
              {r.type === "artifact" && !r.payload.url && r.payload.captureId && (
                <ArtifactCapture
                  id={r.payload.captureId}
                  status={r.payload.status || "failed"}
                  onComplete={onRetry}
                />
              )}
              {r.type === "error" && r.payload.message && <p>{r.payload.message}</p>}
              {r.payload.bytes !== undefined && (
                <small className="muted result-file-size">
                  {new Intl.NumberFormat("ru", { maximumFractionDigits: 1 }).format(
                    r.payload.bytes / 1024,
                  )}{" "}
                  КБ
                </small>
              )}
              {r.type === "plan" && (
                <div className="result-plan">
                  <Markdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      pre: CollapsibleCode,
                      a: ({ node: _node, ...props }) => (
                        <a {...props} target="_blank" rel="noopener noreferrer" />
                      ),
                    }}
                  >
                    {r.payload.text ?? ""}
                  </Markdown>
                </div>
              )}
              {r.payload.command && (
                <CollapsibleCode label="Команда и код">{r.payload.command}</CollapsibleCode>
              )}
              {r.payload.changes?.map((change) => (
                <details className="file-change" key={change.path}>
                  <summary>
                    <span>{change.path.split(/[\\/]/).at(-1)}</span>
                    <span className="small muted">{change.kind}</span>
                    <CopyButton text={change.diff ?? ""} label="Копировать diff" />
                  </summary>
                  <small className="file-path">{change.path}</small>
                  {onFile && (
                    <button type="button" className="secondary" onClick={() => onFile(change.path)}>
                      <Icon name="file" />
                      Посмотреть файл
                    </button>
                  )}
                  <pre>{change.diff || "Сводка изменений без текстового diff"}</pre>
                </details>
              ))}
              {r.turnId && onTurn && (
                <button
                  type="button"
                  className="result-origin"
                  onClick={() => onTurn(r.turnId ?? "", r.threadId)}
                >
                  <Icon name="chat" size={15} />
                  {r.threadTitle || "К сообщению"}
                  <Icon name="chevron" size={14} />
                </button>
              )}
            </article>
          ))}
        {hasMore && (
          <button type="button" className="secondary load-more" disabled={busy} onClick={onOlder}>
            Загрузить ещё результаты
          </button>
        )}
      </div>
      {preview && <PreviewViewer result={preview} onClose={() => setPreview(null)} />}
      {image && (
        <div className="image-viewer" role="dialog" aria-modal="true" aria-label="Просмотр снимка">
          <div className="viewer-toolbar">
            <span>{image.title}</span>
            <DownloadLink className="secondary" href={image.payload.url} name={image.title}>
              Скачать
            </DownloadLink>
            <button
              type="button"
              className="icon-button"
              onClick={() => setImage(null)}
              aria-label="Закрыть снимок"
            >
              <Icon name="close" />
            </button>
          </div>
          <div className="viewer-image">
            <img src={image.payload.url} alt={image.title} />
          </div>
        </div>
      )}
    </section>
  );
}
export function ActivityPane({
  items,
  visible,
  hasMore,
  onOlder,
}: {
  items: Activity[];
  visible: boolean;
  hasMore: boolean;
  onOlder: () => void;
}) {
  return (
    <section className="activity-pane pane" data-visible={visible} aria-label="Активность">
      <div className="pane-heading">
        <span>
          <Icon name="activity" />
          Активность
        </span>
      </div>
      <div className="pane-scroll">
        {!items.length && (
          <div className="empty-state">
            <Icon name="activity" size={30} />
            <h2>Пока тихо.</h2>
          </div>
        )}
        {items.map((item) => (
          <details className="activity-card" key={item.seq}>
            <summary>
              <span>
                {item.payload.command ??
                  item.payload.tool ??
                  item.payload.message ??
                  "Событие Codex"}
              </span>
              <span className="badge">
                {item.payload.exitCode !== undefined
                  ? `Код ${item.payload.exitCode}`
                  : (item.payload.status ?? "")}
              </span>
            </summary>
            <pre>{item.payload.output ?? item.payload.message ?? "Без текстового вывода"}</pre>
          </details>
        ))}
        {hasMore && (
          <button type="button" className="secondary load-more" onClick={onOlder}>
            Загрузить ещё
          </button>
        )}
      </div>
    </section>
  );
}
