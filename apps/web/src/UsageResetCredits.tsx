import type { ResetCredit, ResetOperation, UsageLimitsData } from "@codex-web/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api, messageOf } from "./api";

type Attempt = { id: string; snapshotId: string; creditId?: string; confirm: true };
const storageKey = (machineId: string) => "codex-reset-attempt:" + machineId;
function saved(machineId: string): Attempt | null {
  try {
    const v = JSON.parse(localStorage.getItem(storageKey(machineId)) ?? "null");
    return v && typeof v.id === "string" && typeof v.snapshotId === "string" && v.confirm === true
      ? v
      : null;
  } catch {
    return null;
  }
}
const date = (seconds: number) =>
  new Date(seconds * 1000).toLocaleString("ru", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
const outcomeText = {
  reset: "Сброс активирован.",
  alreadyRedeemed: "Эта попытка уже активировала сброс.",
  nothingToReset: "Сейчас нет лимитов, которые можно сбросить.",
  noCredit: "Доступных сбросов больше нет.",
  unsupported: "Эта версия Codex не поддерживает активацию сброса.",
};

export function UsageResetCredits({
  machineId,
  data,
  refresh,
}: {
  machineId: string;
  data: UsageLimitsData;
  refresh: () => Promise<void>;
}) {
  const [attempt, setAttempt] = useState<Attempt | null>(() => saved(machineId));
  const [operation, setOperation] = useState<ResetOperation | null>(data.resetOperation ?? null);
  const [selection, setSelection] = useState<{
    credit: ResetCredit | null;
    snapshotId: string;
  } | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const running = useRef(false),
    mounted = useRef(true);
  const path = `/machines/${encodeURIComponent(machineId)}/limits/resets`;
  const remember = useCallback(
    (value: Attempt | null) => {
      try {
        if (value) localStorage.setItem(storageKey(machineId), JSON.stringify(value));
        else localStorage.removeItem(storageKey(machineId));
      } catch {}
      if (mounted.current) setAttempt(value);
    },
    [machineId],
  );
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    const op = data.resetOperation;
    if (!attempt && !op) setOperation(null);
    if (op && (!attempt || attempt.id === op.id)) {
      setOperation(op);
      if (op.state === "complete" && attempt?.id === op.id) remember(null);
    }
  }, [data.resetOperation, attempt, remember]);

  // Reload / HTTP failure recovery observes the receipt, never auto-redeems.
  const observedId = attempt?.id ?? (operation?.state === "pending" ? operation.id : null);
  const observedMachine = attempt?.id ? machineId : operation?.machineId;
  useEffect(() => {
    if (!observedId || !observedMachine) return;
    const controller = new AbortController();
    let disposed = false,
      pending = false;
    const observe = async () => {
      if (pending || disposed || document.visibilityState === "hidden") return;
      pending = true;
      try {
        const op = await api<ResetOperation>(
          `/machines/${encodeURIComponent(observedMachine)}/limits/resets/${encodeURIComponent(observedId)}`,
          { signal: controller.signal },
        );
        if (!disposed) {
          setOperation(op);
          if (op.state === "complete") {
            remember(null);
            setError("");
            await refresh();
          }
        }
      } catch {
        /* Keep the durable attempt visible until an explicit check. */
      } finally {
        pending = false;
      }
    };
    void observe();
    const timer = setInterval(() => void observe(), 3000);
    document.addEventListener("visibilitychange", observe);
    return () => {
      disposed = true;
      controller.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", observe);
    };
  }, [observedId, observedMachine, refresh, remember]);

  const run = async (fn: () => Promise<ResetOperation>) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    try {
      const op = await fn();
      if (mounted.current) {
        setOperation(op);
        setSelection(null);
        if (op.state === "complete") remember(null);
      }
    } catch (e) {
      if (mounted.current) {
        if (
          e instanceof ApiError &&
          [
            "RESET_SNAPSHOT_EXPIRED",
            "RESET_LIMITS_CHANGED",
            "RESET_ACCOUNT_CHANGED",
            "RESET_CREDIT_UNAVAILABLE",
            "RESET_PENDING",
          ].includes(e.code)
        ) {
          remember(null);
          setSelection(null);
        }
        setError(messageOf(e));
      }
    } finally {
      // Canonical read replaces both meters and credit rows; no optimistic quota math.
      await refresh();
      window.dispatchEvent(new Event("codex-usage-changed"));
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const activate = () => {
    if (!selection || running.current) return;
    const value: Attempt = {
      id: crypto.randomUUID(),
      snapshotId: selection.snapshotId,
      confirm: true,
      ...(selection.credit ? { creditId: selection.credit.id } : {}),
    };
    remember(value);
    void run(() => api<ResetOperation>(path, { method: "POST", body: value }));
  };
  const verify = () =>
    void run(async () => {
      let op = operation;
      if (attempt) {
        try {
          op = await api<ResetOperation>(path + "/" + attempt.id);
        } catch (e) {
          if (!(e instanceof ApiError) || e.code !== "RESET_ATTEMPT_MISSING") throw e;
          // No Hub receipt: retry only the exact original body and identity.
          try {
            return await api<ResetOperation>(path, { method: "POST", body: attempt });
          } catch (retryError) {
            if (
              retryError instanceof ApiError &&
              [
                "RESET_SNAPSHOT_EXPIRED",
                "RESET_LIMITS_CHANGED",
                "RESET_ACCOUNT_CHANGED",
                "RESET_CREDIT_UNAVAILABLE",
                "RESET_PENDING",
              ].includes(retryError.code)
            )
              remember(null);
            throw retryError;
          }
        }
      }
      if (!op) throw new Error("Обнови лимиты перед проверкой.");
      if (op.state !== "unknown") return op;
      return api<ResetOperation>(
        `/machines/${encodeURIComponent(op.machineId)}/limits/resets/${op.id}/retry`,
        { method: "POST", body: { confirm: true } },
      );
    });
  const summary = data.resetCredits;
  const outstanding = !!attempt || (!!operation && operation.state !== "complete");
  const disabled = busy || outstanding || !data.resetContext;
  const credits =
    summary?.credits?.filter(
      (c) =>
        c.status === "available" &&
        c.resetType === "codexRateLimits" &&
        (c.expiresAt === null || c.expiresAt * 1000 > Date.now()),
    ) ?? [];
  const hasCredits = !!summary && summary.availableCount > 0;
  if (!hasCredits && !operation && !attempt && !error) return null;
  return (
    <section className="usage-resets" aria-label="Сохранённые сбросы Codex">
      {hasCredits && (
        <>
          <div className="usage-reset-heading">
            <strong>Сохранённые сбросы</strong>
            <span className="usage-reset-count">{summary.availableCount}</span>
          </div>
          {summary.credits === null ? (
            <button
              type="button"
              className="secondary"
              disabled={disabled}
              onClick={() => setSelection({ credit: null, snapshotId: data.resetContext! })}
            >
              Использовать один
            </button>
          ) : (
            credits.map((c) => (
              <div className="usage-reset-credit" key={c.id}>
                <div>
                  <strong>{c.title || "Сброс лимитов Codex"}</strong>
                  {c.description && <p>{c.description}</p>}
                  {c.expiresAt !== null && <small>Доступен до {date(c.expiresAt)}</small>}
                </div>
                <button
                  type="button"
                  className="secondary"
                  disabled={disabled}
                  onClick={() => setSelection({ credit: c, snapshotId: data.resetContext! })}
                >
                  Активировать
                </button>
              </div>
            ))
          )}
          {summary.credits !== null && !credits.length && (
            <p className="small muted">Список доступных сбросов пока не подтверждён.</p>
          )}
        </>
      )}
      {selection && !outstanding && (
        <fieldset className="usage-reset-confirm" aria-label="Подтверждение сброса">
          <strong>Использовать сохранённый сброс сейчас?</strong>
          <p>
            Будет использован один сброс. Доступные лимиты и дата их обновления могут измениться.
          </p>
          {selection.credit?.expiresAt != null && (
            <small>Доступен до {date(selection.credit.expiresAt)}</small>
          )}
          <div className="usage-reset-actions">
            <button
              type="button"
              className="secondary"
              onClick={() => setSelection(null)}
              disabled={busy}
            >
              Отмена
            </button>
            <button type="button" className="primary" onClick={activate} disabled={busy}>
              Использовать сброс
            </button>
          </div>
        </fieldset>
      )}
      <div role="status" aria-live="polite">
        {busy ? (
          <p>Проверяю сброс…</p>
        ) : operation?.state === "pending" ? (
          <p>Сброс активируется…</p>
        ) : outstanding ? (
          <p>Исход сброса пока не подтверждён.</p>
        ) : operation?.outcome ? (
          <p>{outcomeText[operation.outcome]}</p>
        ) : null}
        {error && <p className="usage-reset-error">{error}</p>}
        {data.resetUnavailable && hasCredits && (
          <p className="small muted">{data.resetUnavailable}</p>
        )}
      </div>
      {(outstanding || error || data.resetUnavailable) && (
        <div className="usage-reset-actions">
          {outstanding && (
            <button
              type="button"
              className="secondary"
              disabled={busy || operation?.state === "pending"}
              onClick={verify}
            >
              Проверить попытку
            </button>
          )}
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => void refresh()}
          >
            Обновить лимиты
          </button>
        </div>
      )}
    </section>
  );
}
