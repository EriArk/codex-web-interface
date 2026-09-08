import { useRef, useState } from "react";
import { messageOf } from "./api";
import { Icon } from "./icons";
export type RecoveryOutcome = { ok: boolean; message: string };
export function ConnectionRecovery({
  needed,
  error,
  disabled,
  onRecover,
}: {
  needed: boolean;
  error: string;
  disabled: boolean;
  onRecover: () => Promise<RecoveryOutcome>;
}) {
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<RecoveryOutcome>();
  const locked = useRef(false);
  const recover = async () => {
    if (disabled || locked.current) return;
    locked.current = true;
    setPending(true);
    setOutcome(undefined);
    try {
      setOutcome(await onRecover());
    } catch (error) {
      setOutcome({ ok: false, message: messageOf(error) });
    } finally {
      locked.current = false;
      setPending(false);
    }
  };
  if (!needed && !error && !pending && !outcome) return null;
  return (
    <div className="connection-recovery">
      {pending ? (
        <div className="notice" role="status">
          <span className="spin">
            <Icon name="refresh" />
          </span>
          <span>Восстанавливаем связь…</span>
        </div>
      ) : (
        <>
          {(outcome || error) && (
            <div className="notice" role={outcome?.ok ? "status" : "alert"}>
              <span>{outcome?.message || error}</span>
              {outcome?.ok && (
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Скрыть результат восстановления"
                  onClick={() => setOutcome(undefined)}
                >
                  <Icon name="close" />
                </button>
              )}
            </div>
          )}
        </>
      )}
      {(needed || error || pending || outcome?.ok === false) && (
        <button
          type="button"
          className="secondary recovery-button"
          disabled={disabled || pending}
          onClick={() => void recover()}
        >
          <Icon name="refresh" />
          {pending ? "Подключаемся…" : "Восстановить диалог"}
        </button>
      )}
    </div>
  );
}
