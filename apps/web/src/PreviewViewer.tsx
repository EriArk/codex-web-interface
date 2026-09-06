import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, messageOf } from "./api";
import { Icon } from "./icons";
import type { Result } from "./types";
import "./preview.css";

export function PreviewViewer({ result, onClose }: { result: Result; onClose: () => void }) {
  const dialog = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false),
    [error, setError] = useState(""),
    [wide, setWide] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const root = document.getElementById("root"),
      focused = document.activeElement as HTMLElement | null;
    const prior = root?.inert ?? false;
    if (root) root.inert = true;
    dialog.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => {
      if (root) root.inert = prior;
      focused?.focus();
    };
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: The retry counter deliberately reloads a failed document.
  useEffect(() => {
    let disposed = false;
    setReady(false);
    setError("");
    const path = result.payload.url ?? "";
    if (!/^\/api\/previews\/[0-9a-f]{64}$/.test(path)) {
      setError("Демо недоступно.");
      return;
    }
    void api(path.slice(4) + "/ready")
      .then(() => {
        if (!disposed) setReady(true);
      })
      .catch((e) => {
        if (!disposed) setError(messageOf(e));
      });
    return () => {
      disposed = true;
    };
  }, [result.payload.url, attempt]);
  return createPortal(
    <div className="preview-overlay">
      <div
        ref={dialog}
        className="preview-viewer"
        role="dialog"
        aria-modal="true"
        aria-label={result.title}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
          if (event.key === "Tab") {
            const items = dialog.current?.querySelectorAll<HTMLElement>("button, iframe");
            const first = items?.[0],
              last = items?.[items.length - 1];
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <div className="viewer-toolbar">
          <strong>{result.title}</strong>
          <button
            type="button"
            className="secondary"
            aria-pressed={wide}
            onClick={() => setWide(!wide)}
          >
            {wide ? "По ширине" : "960 px"}
          </button>
          <button type="button" className="icon-button" aria-label="Закрыть демо" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
        <div className="preview-stage" data-wide={wide}>
          {!ready && (
            <div className="empty-state" role="status">
              {error ? (
                <>
                  <p>{error}</p>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => setAttempt((n) => n + 1)}
                  >
                    Повторить
                  </button>
                </>
              ) : (
                <>
                  <span className="activity-spinner" />
                  <p>Открываем демо…</p>
                </>
              )}
            </div>
          )}
          {ready && (
            <iframe
              title={result.title}
              src={result.payload.url}
              sandbox="allow-scripts"
              referrerPolicy="no-referrer"
            />
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
