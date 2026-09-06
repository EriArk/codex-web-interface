import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import { CollapsibleCode } from "./CollapsibleCode";
import { Icon } from "./icons";
import type { Activity, Result } from "./types";
export function Results({
  results,
  visible,
  focusId,
  busy,
  hasMore,
  onOlder,
  onTurn,
}: {
  results: Result[];
  visible: boolean;
  focusId: string;
  busy: boolean;
  hasMore: boolean;
  onOlder: () => void;
  onTurn: (id: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null),
    [image, setImage] = useState<Result | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Newly loaded result cards must be focused after rendering.
  useEffect(() => {
    if (visible && focusId)
      requestAnimationFrame(() =>
        ref.current
          ?.querySelector(`[data-result="${CSS.escape(focusId)}"]`)
          ?.scrollIntoView({ block: "center" }),
      );
  }, [focusId, visible, results]);
  return (
    <section className="results-pane pane" data-visible={visible} aria-label="Результаты">
      <div className="pane-heading">
        <span>
          <Icon name="results" />
          Результаты
        </span>
        <span className="small muted">
          {results.length ? `${results.length} сохранено` : "Всё важное — здесь"}
        </span>
      </div>
      <div className="pane-scroll" ref={ref}>
        {!results.length && (
          <div className="empty-state">
            <div className="empty-symbol">
              <Icon name="results" size={29} />
            </div>
            <h2>Здесь появится результат.</h2>
            <p>
              Изменённые файлы, итоги проверок
              <br />и снимки рабочего стола.
            </p>
            <div className="empty-rule" />
            <span className="small muted">Подробности выполнения — в «Активности»</span>
          </div>
        )}
        {results
          .toSorted((a, b) => Number(b.type === "image") - Number(a.type === "image"))
          .map((r) => (
            <article className={`result-card result-${r.type}`} key={r.id} data-result={r.id}>
              <div className="result-title">
                <span className="result-icon">
                  <Icon
                    name={r.type === "image" ? "image" : r.type === "check" ? "check" : "folder"}
                  />
                </span>
                <div>
                  <h3>{r.title}</h3>
                  <time>
                    {new Date(r.createdAt).toLocaleString("ru", {
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
                  onClick={() => setImage(r)}
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
              {r.type === "plan" && (
                <div className="result-plan">
                  <Markdown components={{ pre: CollapsibleCode }}>{r.payload.text ?? ""}</Markdown>
                </div>
              )}
              {r.payload.command && (
                <details className="code-disclosure">
                  <summary>Команда и код</summary>
                  <pre>{r.payload.command}</pre>
                </details>
              )}
              {r.payload.changes?.map((change) => (
                <details className="file-change" key={change.path}>
                  <summary>
                    <span>{change.path.split(/[\\/]/).at(-1)}</span>
                    <span className="small muted">{change.kind}</span>
                  </summary>
                  <small className="file-path">{change.path}</small>
                  <pre>{change.diff || "Сводка изменений без текстового diff"}</pre>
                </details>
              ))}
              {r.turnId && (
                <button
                  type="button"
                  className="result-origin"
                  onClick={() => onTurn(r.turnId ?? "")}
                >
                  <Icon name="chat" size={15} />К сообщению
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
      {image && (
        <div className="image-viewer" role="dialog" aria-modal="true" aria-label="Просмотр снимка">
          <div className="viewer-toolbar">
            <span>{image.title}</span>
            <a className="secondary" href={image.payload.url} download="screenshot.png">
              Скачать
            </a>
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
        <span className="small muted">Детали выполнения</span>
      </div>
      <div className="pane-scroll">
        {!items.length && (
          <div className="empty-state">
            <Icon name="activity" size={30} />
            <h2>Пока тихо.</h2>
            <p>Команды и подробный вывод будут здесь.</p>
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
