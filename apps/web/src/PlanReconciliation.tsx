import type {
  NotebookTarget,
  ReconciliationApply,
  ReconciliationDetail,
  ReconciliationItem,
  WorkReview,
} from "@codex-web/shared";
import { useEffect, useRef, useState } from "react";
import { api, messageOf } from "./api";
import { Icon } from "./icons";

const labels: Record<ReconciliationItem["state"], string> = {
  verified: "Выполнено · есть проверка",
  complete: "Заявлено выполненным",
  partial: "Частично",
  unknown: "Нужно проверить",
  not_done: "Не выполнено",
};
export function PlanReconciliation({
  review,
  onOpen,
}: {
  review: WorkReview;
  onOpen: (target: NotebookTarget) => void;
}) {
  const [data, setData] = useState<ReconciliationDetail | null>(null),
    [selected, setSelected] = useState<string[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [version, setVersion] = useState(0);
  const alive = useRef(false),
    generation = useRef(0),
    receipt = useRef<{ key: string; body: ReconciliationApply } | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: An explicit refresh rereads a revision conflict without changing owner selection.
  useEffect(() => {
    let active = true;
    const epoch = ++generation.current;
    void api<ReconciliationDetail>(`/workspace/reviews/${review.id}/plan`)
      .then((v) => {
        if (active && epoch === generation.current) {
          setData(v);
          setError("");
        }
      })
      .catch((e) => {
        if (active && epoch === generation.current) setError(messageOf(e));
      });
    return () => {
      active = false;
    };
  }, [review.id, review.revision, version]);
  const apply = async () => {
    if (!data || busy || !selected.length) return;
    generation.current++;
    const key = JSON.stringify([review.id, review.revision, data.proposal.planRevision, selected]);
    if (receipt.current?.key !== key)
      receipt.current = {
        key,
        body: {
          requestId: crypto.randomUUID(),
          reviewRevision: review.revision,
          planRevision: data.proposal.planRevision,
          itemIds: selected,
        },
      };
    setBusy(true);
    setError("");
    try {
      const next = await api<ReconciliationDetail>(`/workspace/reviews/${review.id}/plan`, {
        method: "POST",
        body: receipt.current.body,
      });
      if (alive.current) {
        setData(next);
        window.dispatchEvent(new Event("work-review-changed"));
      }
    } catch (e) {
      if (alive.current) setError(messageOf(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const p = data?.proposal,
    canApply = data?.planState === "matching" && review.state === "accepted" && !p?.applied;
  return (
    <section className="plan-reconcile" aria-label="Сверка плана">
      <header>
        <div>
          <h3>Сверка плана</h3>
          <small>Версия {p?.planRevision ?? review.plan?.revision}</small>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="Обновить сверку"
          disabled={busy}
          onClick={() => setVersion((v) => v + 1)}
        >
          <Icon name="refresh" size={18} />
        </button>
      </header>
      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
      {!p && !error && (
        <p role="status">
          <span className="spinner" /> Загружаю…
        </p>
      )}
      {p && (
        <>
          {p.origin !== "structured" && (
            <p className="review-caption">
              Нет подтверждений по отдельным пунктам. План не изменён.
            </p>
          )}
          <div className="reconcile-items">
            {p.items.map((item) => {
              const eligible = !item.wasChecked && ["complete", "verified"].includes(item.state);
              const evidence = review.evidence.filter((e) => item.evidenceIds.includes(e.id));
              return (
                <div className="reconcile-item" key={item.id} data-state={item.state}>
                  <label>
                    <input
                      type="checkbox"
                      aria-label={item.text}
                      checked={
                        item.wasChecked ||
                        (p.applied
                          ? p.applied.itemIds.includes(item.id)
                          : selected.includes(item.id))
                      }
                      disabled={busy || !!p.applied || !eligible || data?.planState !== "matching"}
                      onChange={(e) =>
                        setSelected((old) =>
                          e.target.checked ? [...old, item.id] : old.filter((id) => id !== item.id),
                        )
                      }
                    />
                    <span>
                      <small>{item.section}</small>
                      <strong>{item.text}</strong>
                      <em>{item.wasChecked ? "Было выполнено" : labels[item.state]}</em>
                    </span>
                  </label>
                  {(item.note || evidence.length > 0) && (
                    <details>
                      <summary>Основание{evidence.length ? ` · ${evidence.length}` : ""}</summary>
                      {item.note && <p>{item.note}</p>}
                      {evidence.map((e) =>
                        e.target ? (
                          <button
                            key={e.id}
                            type="button"
                            className="secondary"
                            onClick={() => onOpen(e.target!)}
                          >
                            {e.title}
                            <Icon name="chevron" size={15} />
                          </button>
                        ) : (
                          <p key={e.id}>{e.title}</p>
                        ),
                      )}
                    </details>
                  )}
                </div>
              );
            })}
          </div>
          {p.applied ? (
            <p className="reconcile-applied" role="status">
              <Icon name="check" size={18} /> Отмечено пунктов: {p.applied.itemIds.length} · версия{" "}
              {p.applied.planRevision}
            </p>
          ) : (
            <>
              {data?.planState !== "matching" ? (
                <p className="notice">
                  {data?.planState === "deleted"
                    ? "План удалён. Предложение сохранено."
                    : "План уже изменён. Предложение относится к прежней версии."}
                </p>
              ) : (
                <>
                  {review.state !== "accepted" && (
                    <p className="review-caption">
                      Прими работу, чтобы отметить выбранные пункты в плане.
                    </p>
                  )}
                  <button
                    type="button"
                    className="secondary"
                    disabled={!canApply || busy || !selected.length}
                    onClick={() => void apply()}
                  >
                    <Icon name="check" size={17} />
                    {busy
                      ? "Сохраняю…"
                      : `Отметить выбранные${selected.length ? ` · ${selected.length}` : ""}`}
                  </button>
                </>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
