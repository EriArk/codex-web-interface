import { useEffect, useRef, useState } from "react";
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
  const [failure, setFailure] = useState("");
  const locked = useRef(false),
    attempted = useRef(false),
    mounted = useRef(true);
  const recoverRef = useRef(onRecover);
  recoverRef.current = onRecover;
  const recover = async () => {
    if (disabled || locked.current) return;
    locked.current = true;
    attempted.current = true;
    setPending(true);
    try {
      const result = await recoverRef.current();
      if (mounted.current) setFailure(result.ok ? "" : result.message);
    } catch (e) {
      if (mounted.current) setFailure(messageOf(e));
    } finally {
      locked.current = false;
      if (mounted.current) setPending(false);
    }
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // One quiet attempt per outage; normal rendering must not create a retry loop.
  useEffect(() => {
    if (!needed && !error) {
      attempted.current = false;
      setFailure("");
      return;
    }
    if (!disabled && !attempted.current) void recover();
  });
  // A restored network is a new opportunity, not a reason to replay a message.
  useEffect(() => {
    const online = () => {
      if (!disabled && (needed || error) && !locked.current) void recover();
    };
    window.addEventListener("online", online);
    return () => window.removeEventListener("online", online);
  });
  if (!failure) return null;
  return (
    <div className="connection-recovery">
      <div className="notice" role="alert">
        <span>{failure}</span>
      </div>
      <button
        type="button"
        className="secondary recovery-button"
        disabled={disabled || pending}
        onClick={() => void recover()}
      >
        <Icon name="refresh" />
        {pending ? "Подключаемся…" : "Повторить подключение"}
      </button>
    </div>
  );
}
