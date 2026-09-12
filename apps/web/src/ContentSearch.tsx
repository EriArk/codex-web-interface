import type { NotebookLink } from "@codex-web/shared";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, messageOf } from "./api";
import { Icon } from "./icons";
import "./quick-capture.css";
export type SearchRequest = { client: "codex" | "gpt"; threadId?: string; query?: string };
type Page = {
  items: { target: NotebookLink; snippet: string }[];
  nextOffset: number | null;
  coverage: string;
  scanned: number;
};
export function openContentSearch(detail: SearchRequest) {
  window.dispatchEvent(new CustomEvent("workspace-content-search", { detail }));
}
export function ContentSearch({
  request,
  onClose,
  onTarget,
}: {
  request: SearchRequest;
  onClose: () => void;
  onTarget: (target: NotebookLink) => void;
}) {
  const [query, setQuery] = useState(request.query ?? ""),
    [scope, setScope] = useState(request.threadId ? "chat" : "all"),
    [result, setResult] = useState<Page | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null),
    pending = useRef<AbortController | null>(null),
    last = useRef("");
  useEffect(() => {
    const focus = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    dialog.current?.focus({ preventScroll: true });
    return () => {
      pending.current?.abort();
      dialog.current?.close();
      focus?.focus({ preventScroll: true });
    };
  }, []);
  const search = async (more = false) => {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError("");
    if (!more) setResult(null);
    const params = new URLSearchParams({
      q: query.trim(),
      client: request.client,
      offset: String(more ? (result?.nextOffset ?? 0) : 0),
    });
    if (scope === "chat" && request.threadId) params.set("threadId", request.threadId);
    try {
      const page = await api<Page>("/workspace/search?" + params, { signal: controller.signal });
      if (!controller.signal.aborted) {
        last.current = query;
        setResult((old) =>
          more && old
            ? {
                ...page,
                scanned: old.scanned + page.scanned,
                items: [...old.items, ...page.items].filter(
                  (item, index, all) =>
                    all.findIndex(
                      (other) => JSON.stringify(other.target) === JSON.stringify(item.target),
                    ) === index,
                ),
              }
            : page,
        );
      }
    } catch (e) {
      if (!controller.signal.aborted) setError(messageOf(e));
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  const labels = {
    note: "Заметка",
    task: "Задача",
    plan: "План",
    report: "Отчёт",
    thread: "Сообщение",
  };
  return createPortal(
    <dialog
      ref={dialog}
      className="quick-capture-dialog content-search"
      tabIndex={-1}
      aria-label="Поиск по содержимому"
      onCancel={onClose}
    >
      <header>
        <Icon name="search" />
        <h2>Поиск по содержимому</h2>
        <button type="button" className="icon-button" aria-label="Закрыть поиск" onClick={onClose}>
          <Icon name="close" />
        </button>
      </header>
      <div className="quick-capture-content">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void search();
          }}
        >
          <input
            type="search"
            aria-label="Искать в тексте"
            value={query}
            maxLength={120}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Слова из сообщения или записи…"
          />
          <select
            aria-label="Где искать"
            value={scope}
            onChange={(e) => {
              pending.current?.abort();
              setBusy(false);
              setScope(e.target.value);
              setResult(null);
            }}
          >
            <option value="all">Сохранённое на сервере</option>
            {request.threadId && (
              <option value="chat">
                Текущий чат · {request.client === "gpt" ? "GPT" : "Codex"}
              </option>
            )}
          </select>
          <button type="submit" className="primary" disabled={busy || query.trim().length < 2}>
            Найти
          </button>
        </form>
        {error && <p role="alert">{error}</p>}
        {busy && <p role="status">Ищем…</p>}
        {result && (
          <>
            <p>{result.coverage}</p>
            <small>Проверено элементов: {result.scanned}</small>
            {!result.items.length && !busy && <p>В проверенной части совпадений нет.</p>}
            {result.items.map((item) => (
              <button
                type="button"
                className="content-search-result secondary"
                key={JSON.stringify(item.target)}
                onClick={() => {
                  onClose();
                  onTarget(item.target);
                }}
              >
                <small>
                  {labels[item.target.kind as keyof typeof labels] ?? "Источник"} ·{" "}
                  {item.target.client === "gpt" ? "GPT" : "Codex"}
                </small>
                <strong>{item.target.title}</strong>
                <span>{item.snippet}</span>
              </button>
            ))}
            {result.nextOffset !== null && (
              <button
                type="button"
                className="secondary"
                disabled={busy || last.current !== query}
                onClick={() => void search(true)}
              >
                Искать дальше
              </button>
            )}
          </>
        )}
      </div>
    </dialog>,
    document.body,
  );
}
