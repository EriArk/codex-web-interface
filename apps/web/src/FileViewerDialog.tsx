import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./icons";
import "./file-viewer.css";
import "./workspace-window.css";

/** Shared file workspace. Format tools occupy the content rail; future conversions are file actions. */
export function FileViewerDialog({
  name,
  file,
  source,
  onClose,
  children,
  actions,
}: {
  name: string;
  file?: File | null;
  source?: string;
  onClose: () => void;
  children: ReactNode;
  actions?: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [properties, setProperties] = useState(false),
    [expanded, setExpanded] = useState(false);
  useEffect(() => {
    dialog.current?.showModal();
    dialog.current?.focus({ preventScroll: true });
  }, []);
  const format = (file?.name || name).split(".").at(-1)?.toUpperCase();
  return createPortal(
    <dialog
      ref={dialog}
      className="file-viewer-dialog"
      data-expanded={expanded}
      aria-label="Просмотр файла"
      tabIndex={-1}
      onCancel={onClose}
    >
      <header className="file-viewer-heading">
        <span className="file-viewer-mark">
          <Icon name="file" />
        </span>
        <div>
          <strong title={name}>{name}</strong>
          <small>Просмотр файла{format && format.length < 10 ? " · " + format : ""}</small>
        </div>
        <div className="file-viewer-window-controls">
          <button
            type="button"
            className="icon-button"
            aria-label="Свойства файла"
            title="Свойства файла"
            aria-pressed={properties}
            onClick={() => setProperties(!properties)}
          >
            <Icon name="panel-right" />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label={expanded ? "Восстановить окно" : "Развернуть окно"}
            title={expanded ? "Восстановить окно" : "Развернуть окно"}
            onClick={() => setExpanded(!expanded)}
          >
            <Icon name="expand" />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Закрыть просмотр"
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </div>
      </header>
      <div className="file-viewer-body" data-properties={properties}>
        <section className="file-viewer-content" aria-label="Содержимое файла">
          {children}
        </section>
        {properties && (
          <aside className="file-viewer-properties" aria-label="Свойства">
            <strong>Свойства</strong>
            <dl>
              <dt>Имя</dt>
              <dd>{name}</dd>
              <dt>Формат</dt>
              <dd>{format || "Файл"}</dd>
              {file && (
                <>
                  <dt>Размер</dt>
                  <dd>
                    {new Intl.NumberFormat("ru", { maximumFractionDigits: 2 }).format(
                      file.size / 1024,
                    )}{" "}
                    КБ
                  </dd>
                </>
              )}
              {source && (
                <>
                  <dt>Источник</dt>
                  <dd>
                    {source.includes("version=index")
                      ? "Индекс Git"
                      : source.includes("/files/content?")
                        ? "Рабочая копия"
                        : "Сохранённый файл"}
                  </dd>
                </>
              )}
            </dl>
          </aside>
        )}
      </div>
      <footer className="file-viewer-footer">
        <span>Исходный файл</span>
        <div className="file-viewer-actions">{actions}</div>
      </footer>
    </dialog>,
    document.body,
  );
}
