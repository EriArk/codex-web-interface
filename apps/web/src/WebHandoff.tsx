import { useEffect, useId, useRef, useState } from "react";
import { ApiError, api, messageOf } from "./api";

type Desktop = { client?: string; returning?: boolean; operation?: { state: string } };
export function useWebHandoff(machineId: string | undefined, threadId: string) {
  const titleId = useId();
  const [asking, setAsking] = useState(false),
    [pending, setPending] = useState(false),
    [error, setError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null),
    choice = useRef<((yes: boolean) => void) | undefined>(undefined),
    controller = useRef<AbortController | undefined>(undefined),
    locked = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Cancel the old conversation operation on navigation.
  useEffect(() => {
    setError("");
    setAsking(false);
    setPending(false);
    locked.current = false;
    return () => {
      choice.current?.(false);
      choice.current = undefined;
      controller.current?.abort();
    };
  }, [threadId]);
  useEffect(() => {
    if (asking) dialog.current?.showModal();
    else dialog.current?.close();
  }, [asking]);
  const answer = (yes: boolean) => {
    choice.current?.(yes);
    choice.current = undefined;
    setAsking(false);
  };
  const run = async (action: (returned?: boolean) => Promise<boolean>) => {
    if (locked.current) return false;
    locked.current = true;
    setError("");
    const lifetime = new AbortController();
    controller.current = lifetime;
    try {
      try {
        const acknowledged = await action();
        return acknowledged && !lifetime.signal.aborted;
      } catch (e) {
        if (!(e instanceof ApiError) || e.code !== "MACHINE_RELEASED" || !machineId) throw e;
      }
      if (lifetime.signal.aborted) return false;
      setAsking(true);
      const yes = await new Promise<boolean>((resolve) => {
        choice.current = resolve;
      });
      if (!yes || lifetime.signal.aborted) return false;
      setPending(true);
      const path = "/machines/" + encodeURIComponent(machineId),
        key = crypto.randomUUID();
      let state: Desktop;
      try {
        state = await api<Desktop>(path + "/client", {
          method: "POST",
          key,
          body: { client: "web", releaseDesktop: true, confirmStopTasks: true },
          signal: lifetime.signal,
        });
      } catch (e) {
        // A lost acknowledgement may still be reconciled by the Hub. Never repeat the close command.
        if (
          !(e instanceof ApiError) ||
          !["OFFLINE", "INVALID_RESPONSE", "HANDOFF_PENDING"].includes(e.code)
        )
          throw e;
        state = await api<Desktop>(path + "/desktop", { signal: lifetime.signal });
      }
      const deadline = Date.now() + 125000;
      while (state.client !== "web" || state.returning) {
        if (!state.returning || Date.now() > deadline)
          throw new Error("Не удалось подтвердить переход. Сообщение и вложения сохранены.");
        await new Promise<void>((resolve, reject) => {
          const cancel = () => {
            clearTimeout(timer);
            reject(new DOMException("Aborted", "AbortError"));
          };
          const timer = setTimeout(() => {
            lifetime.signal.removeEventListener("abort", cancel);
            resolve();
          }, 1500);
          lifetime.signal.addEventListener("abort", cancel, { once: true });
        });
        state = await api<Desktop>(path + "/desktop", { signal: lifetime.signal });
      }
      if (lifetime.signal.aborted) return false;
      const acknowledged = await action(true);
      return acknowledged && !lifetime.signal.aborted;
    } catch (e) {
      if (!lifetime.signal.aborted) setError(messageOf(e));
      return false;
    } finally {
      if (!lifetime.signal.aborted) {
        setPending(false);
        setAsking(false);
      }
      if (controller.current === lifetime) locked.current = false;
    }
  };
  const panel = (
    <>
      <dialog
        ref={dialog}
        className="web-handoff-dialog"
        aria-labelledby={titleId}
        onCancel={(e) => {
          e.preventDefault();
          answer(false);
        }}
      >
        <h2 id={titleId}>Продолжить на сайте?</h2>
        <p>
          Codex на компьютере закроется, его текущие задачи остановятся. Сообщение с вложениями
          отправится в этот чат.
        </p>
        <div className="desktop-control-actions">
          <button type="button" className="secondary" onClick={() => answer(false)}>
            Отмена
          </button>
          <button type="button" onClick={() => answer(true)}>
            Продолжить и отправить
          </button>
        </div>
      </dialog>
      {pending && (
        <div className="composer-error" role="status">
          <span className="spinner" /> Переключаю на сайт…
        </div>
      )}
      {error && (
        <div className="send-error" role="alert">
          {error}
        </div>
      )}
    </>
  );
  return { run, panel, pending: pending || asking };
}
