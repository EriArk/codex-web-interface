import type {
  NotebookLink,
  NotebookTarget,
  ProjectAction,
  ReviewDetail,
  ReviewPage,
  WorkReview,
} from "@codex-web/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { accountLocalStorage as localStorage } from "./accountStorage.ts";
import { api, messageOf } from "./api";
import { CollapsibleCode } from "./CollapsibleCode";
import { CopyButton } from "./CopyButton";
import { Icon } from "./icons";
import { MarkdownTable } from "./MarkdownTable";
import type { NotebookRequest } from "./Notebook";
import { PlanReconciliation } from "./PlanReconciliation";
import { ProjectActionPanel } from "./ProjectAction";
import { DeliveryButton } from "./ProjectDeliveryHost";
import { reviewLabels } from "./WorkReviewLink";
import "./work-review.css";

const stamp = (n: number) =>
  new Date(n).toLocaleString("ru", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
export default function WorkReviewPanel({
  request,
  onClose,
  onOpen,
}: {
  request: NotebookRequest;
  onClose: () => void;
  onOpen: (target: NotebookLink) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    alive = useRef(true),
    generation = useRef(0);
  const [page, setPage] = useState<ReviewPage>({ items: [], nextOffset: null }),
    [selected, setSelected] = useState(request.itemId ?? ""),
    [detail, setDetail] = useState<ReviewDetail | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [note, setNote] = useState(""),
    [editing, setEditing] = useState(false),
    [version, setVersion] = useState(0),
    [action, setAction] = useState<ProjectAction | null>(null);
  const decision = useRef<{ key: string; body: Record<string, unknown> } | null>(null),
    preparation = useRef<{ key: string; id: string } | null>(null);
  const scope = request.scope ? `${request.scope.client}:${request.scope.projectId}` : "all";
  useEffect(() => {
    alive.current = true;
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    dialog.current?.focus({ preventScroll: true });
    return () => {
      alive.current = false;
      generation.current++;
      dialog.current?.close();
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Explicit refresh rereads bounded Hub metadata.
  useEffect(() => {
    const abort = new AbortController();
    void api<ReviewPage>(`/workspace/reviews?scope=${encodeURIComponent(scope)}`, {
      signal: abort.signal,
    })
      .then((p) => {
        if (!abort.signal.aborted) {
          setPage(p);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (!abort.signal.aborted) {
          setError(messageOf(e));
          setLoading(false);
        }
      });
    return () => abort.abort();
  }, [scope, version]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Explicit refresh also reloads a conflicting revision without changing the selected work.
  useEffect(() => {
    const abort = new AbortController();
    generation.current++;
    setDetail(null);
    setAction(null);
    setError("");
    setEditing(false);
    decision.current = null;
    preparation.current = null;
    if (selected) {
      setLoading(true);
      void api<ReviewDetail>(`/workspace/reviews/${selected}`, { signal: abort.signal })
        .then((v) => {
          if (abort.signal.aborted) return;
          setDetail(v);
          setAction(v.correction ?? null);
          setLoading(false);
          let saved = "";
          try {
            saved = localStorage.getItem("work-review-note:" + selected) ?? "";
          } catch {}
          setNote(saved || v.review.note);
        })
        .catch((e) => {
          if (!abort.signal.aborted) {
            setError(messageOf(e));
            setLoading(false);
          }
        });
    }
    return () => abort.abort();
  }, [selected, version]);
  const updateAction = useCallback((v: ProjectAction) => setAction(v), []);
  const refresh = () => {
    setError("");
    setVersion((v) => v + 1);
  };
  const saveDecision = async (state: "accepted" | "needs_fixes") => {
    if (!detail || busy) return;
    const epoch = generation.current,
      r = detail.review,
      text = state === "needs_fixes" ? note : "";
    const key = JSON.stringify([r.id, r.revision, state, text]);
    if (decision.current?.key !== key)
      decision.current = {
        key,
        body: { requestId: crypto.randomUUID(), revision: r.revision, decision: state, note: text },
      };
    setBusy(true);
    setError("");
    try {
      const next = await api<WorkReview>(`/workspace/reviews/${r.id}/decision`, {
        method: "POST",
        body: decision.current.body,
      });
      if (!alive.current || epoch !== generation.current) return;
      setDetail({ ...detail, review: next });
      setEditing(false);
      try {
        localStorage.removeItem("work-review-note:" + r.id);
      } catch {}
      window.dispatchEvent(new Event("work-review-changed"));
      setPage((old) => ({
        ...old,
        items: old.items.map((item) => (item.id === next.id ? { ...item, ...next } : item)),
      }));
    } catch (e) {
      if (alive.current && epoch === generation.current) setError(messageOf(e));
    } finally {
      if (alive.current && epoch === generation.current) setBusy(false);
    }
  };
  const prepareCorrection = async () => {
    if (!detail || busy) return;
    const epoch = generation.current,
      r = detail.review,
      key = r.id + ":" + r.revision;
    if (preparation.current?.key !== key) preparation.current = { key, id: crypto.randomUUID() };
    setBusy(true);
    setError("");
    try {
      const next = await api<ProjectAction>("/workspace/actions/" + preparation.current.id, {
        method: "PUT",
        body: { scope: r.scope, kind: "correction", reviewId: r.id, reviewRevision: r.revision },
      });
      if (alive.current && epoch === generation.current) setAction(next);
    } catch (e) {
      if (alive.current && epoch === generation.current) setError(messageOf(e));
    } finally {
      if (alive.current && epoch === generation.current) setBusy(false);
    }
  };
  const open = (t: NotebookTarget) => {
    onClose();
    onOpen({ ...t, availability: "unknown" });
  };
  const r = detail?.review;
  return (
    <dialog
      ref={dialog}
      tabIndex={-1}
      className="work-review-dialog"
      aria-label="Приёмка работы"
      onCancel={onClose}
    >
      <header className="work-review-header">
        <div>
          <small>{request.scope?.name ?? "Проекты"}</small>
          <h2>Приёмка работы</h2>
        </div>
        <div>
          <button
            type="button"
            className="icon-button"
            aria-label="Обновить приёмку"
            disabled={busy}
            onClick={refresh}
          >
            <Icon name="refresh" />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Закрыть приёмку"
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </div>
      </header>
      <div className="work-review-layout" data-selected={!!selected}>
        <nav className="work-review-list" aria-label="Завершённые работы">
          {!page.items.length && !loading && (
            <p className="muted">Здесь появится выполненная работа по планам.</p>
          )}
          {page.items.map((item) => (
            <button
              type="button"
              key={item.id}
              aria-current={item.id === selected ? "true" : undefined}
              disabled={busy}
              onClick={() => setSelected(item.id)}
            >
              <span className="review-dot" data-state={item.state}>
                <Icon name={item.state === "accepted" ? "check" : "plan"} size={18} />
              </span>
              <span>
                <strong>{item.title}</strong>
                <small>
                  {reviewLabels[item.state]} · {stamp(item.createdAt)}
                </small>
              </span>
              <Icon name="chevron" size={15} />
            </button>
          ))}
          {page.nextOffset !== null && (
            <button
              type="button"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const p = await api<ReviewPage>(
                    `/workspace/reviews?scope=${encodeURIComponent(scope)}&offset=${page.nextOffset}`,
                  );
                  if (alive.current)
                    setPage((old) => ({
                      items: [
                        ...old.items,
                        ...p.items.filter((i) => !old.items.some((o) => o.id === i.id)),
                      ],
                      nextOffset: p.nextOffset,
                    }));
                } catch (e) {
                  setError(messageOf(e));
                } finally {
                  if (alive.current) setBusy(false);
                }
              }}
            >
              Загрузить ещё
            </button>
          )}
        </nav>
        <section className="work-review-detail" aria-label="Результат работы">
          {selected && (
            <button
              type="button"
              className="review-back secondary"
              disabled={busy}
              onClick={() => setSelected("")}
            >
              <Icon name="back" size={17} />К списку
            </button>
          )}
          {error && (
            <p className="notice" role="alert">
              {error}
            </p>
          )}
          {loading && (
            <p role="status">
              <span className="spinner" /> Загружаю…
            </p>
          )}
          {!selected && !loading && (
            <p className="muted">Выбери работу, чтобы посмотреть результат и оставить решение.</p>
          )}
          {r && (
            <>
              <div className="review-title">
                <span className="review-state" data-state={r.state}>
                  {reviewLabels[r.state]}
                </span>
                <h2>{r.title}</h2>
                <small>
                  {r.scope.client === "gpt" ? "GPT" : "Codex"} · {r.scope.name} ·{" "}
                  {stamp(r.createdAt)}
                </small>
              </div>
              <div className="review-facts">
                <span>
                  Результаты <strong>{r.evidenceTotal}</strong>
                </span>
                <span>
                  Команды без ошибки{" "}
                  <strong>{r.evidence.filter((e) => e.status === "passed").length}</strong>
                </span>
                {r.evidence.some((e) => e.status === "failed") && (
                  <span className="review-failed">
                    С ошибкой{" "}
                    <strong>{r.evidence.filter((e) => e.status === "failed").length}</strong>
                  </span>
                )}
              </div>
              <div className="review-context-links">
                {r.source && (r.source.turnId || r.source.messageId) && (
                  <button type="button" className="secondary" onClick={() => open(r.source!)}>
                    <Icon name="chat" size={17} />К ответу
                  </button>
                )}
                {r.plan && (
                  <button
                    type="button"
                    className="secondary"
                    onClick={() =>
                      open({
                        client: r.scope.client,
                        kind: "plan",
                        id: r.plan!.id,
                        title: r.plan!.title,
                        projectId: r.scope.projectId,
                      })
                    }
                  >
                    <Icon name="plan" size={17} />
                    План · версия {r.plan.revision}
                  </button>
                )}
                {r.scope.client === "codex" && (
                  <DeliveryButton
                    projectId={r.scope.projectId}
                    projectName={r.scope.name}
                    reviewId={r.id}
                  />
                )}
                {r.scope.client === "codex" && (
                  <button
                    type="button"
                    className="secondary"
                    onClick={() =>
                      open({
                        client: "codex",
                        kind: "file",
                        id: ".",
                        title: "Файлы и Git",
                        projectId: r.scope.projectId,
                      })
                    }
                  >
                    <Icon name="folder" size={17} />
                    Файлы и Git сейчас
                  </button>
                )}
              </div>
              {r.git && (
                <p className="review-caption">
                  Последнее наблюдение Git: {r.git.branch ?? "без ветки"} · {r.git.changed}{" "}
                  изменений · {stamp(r.git.checkedAt)}
                </p>
              )}
              <section className="review-answer">
                <header>
                  <h3>Сохранённый ответ</h3>
                  <CopyButton text={r.answer} label="Копировать результат работы" />
                </header>
                <Markdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    pre: CollapsibleCode,
                    table: MarkdownTable,
                    img: () => null,
                    a: ({ node: _node, ...props }) => (
                      <a {...props} target="_blank" rel="noopener noreferrer" />
                    ),
                  }}
                >
                  {r.answer || "Ответ без текста; смотри результаты."}
                </Markdown>
                {r.answerTruncated && <small>Показана сохранённая часть длинного ответа.</small>}
              </section>
              {!!r.evidence.length && (
                <details className="review-evidence">
                  <summary>Результаты и команды · {r.evidenceTotal}</summary>
                  {r.evidence.map((e) => (
                    <div key={e.id}>
                      <span className="review-dot" data-state={e.status}>
                        {e.status === "passed" ? (
                          <Icon name="check" size={16} />
                        ) : (
                          <Icon name="results" size={16} />
                        )}
                      </span>
                      {e.target ? (
                        <button type="button" onClick={() => open(e.target!)}>
                          {e.title}
                          <Icon name="chevron" size={15} />
                        </button>
                      ) : (
                        <span>{e.title}</span>
                      )}
                      {e.exitCode !== undefined && <small>exit {e.exitCode}</small>}
                    </div>
                  ))}
                  {r.evidenceTotal > r.evidence.length && (
                    <p className="muted">Остальное — в результатах исходного хода.</p>
                  )}
                </details>
              )}
              {r.plan && <PlanReconciliation key={r.id} review={r} onOpen={open} />}
              {r.parentReviewId && (
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setSelected(r.parentReviewId!)}
                >
                  Исходная приёмка
                </button>
              )}
              {r.decidedAt && <p className="review-caption">Твоё решение · {stamp(r.decidedAt)}</p>}
              {r.note && !editing && (
                <blockquote className="review-owner-note">{r.note}</blockquote>
              )}
              {editing ? (
                <div className="review-correction">
                  <label htmlFor="review-correction-text">Что исправить</label>
                  <textarea
                    id="review-correction-text"
                    value={note}
                    maxLength={4000}
                    rows={4}
                    onChange={(e) => {
                      setNote(e.target.value);
                      try {
                        localStorage.setItem("work-review-note:" + r.id, e.target.value);
                      } catch {
                        setError("Не удалось сохранить замечание на устройстве.");
                      }
                    }}
                  />
                  <div>
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy}
                      onClick={() => setEditing(false)}
                    >
                      Назад
                    </button>
                    <button
                      type="button"
                      className="primary"
                      disabled={busy || !note.trim()}
                      onClick={() => void saveDecision("needs_fixes")}
                    >
                      Сохранить замечание
                    </button>
                  </div>
                </div>
              ) : (
                <div className="review-decisions">
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() => setEditing(true)}
                  >
                    {r.state === "needs_fixes" ? "Изменить замечание" : "Нужны исправления"}
                  </button>
                  {r.state !== "accepted" && (
                    <button
                      type="button"
                      className="primary"
                      disabled={busy}
                      onClick={() => void saveDecision("accepted")}
                    >
                      <Icon name="check" size={18} />
                      Принять работу
                    </button>
                  )}
                </div>
              )}
              {r.state === "needs_fixes" && !editing && (
                <div className="review-followup">
                  {detail.currentThreadId !== r.threadId && (
                    <p className="notice">
                      Рабочий чат изменился. Исправления пойдут в «{detail.currentTitle}».
                    </p>
                  )}
                  {!action || ["completed", "cancelled", "failed"].includes(action.state) ? (
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy || !detail.currentThreadId}
                      onClick={() => void prepareCorrection()}
                    >
                      <Icon name="chat" size={18} />
                      Подготовить исправление
                    </button>
                  ) : null}
                  {action && (
                    <ProjectActionPanel initial={action} onChange={updateAction} onOpen={onOpen} />
                  )}
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </dialog>
  );
}
