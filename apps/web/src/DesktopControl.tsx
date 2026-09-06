import { useEffect, useRef, useState } from "react";
import { api, messageOf } from "./api";
import { Icon } from "./icons";
import type { Machine } from "./types";
import "./desktopControl.css";

interface State {
  running: boolean;
  activityKnown: boolean;
  activeTasks: number;
  operation: null | { id: string; kind: string; state: string; code: string; requestedAt: number };
}
const operationText = (state: State) => {
  const op = state.operation;
  if (!op || op.kind !== "restart") return "";
  if (["queued", "restarting"].includes(op.state))
    return "Перезапускаю Codex… Можно закрыть настройки.";
  if (op.state === "completed") return "Codex снова открыт на компьютере.";
  if (op.code === "DESKTOP_BUSY")
    return "Началась задача. Перезапуск отменён — дождись её завершения.";
  if (op.code === "DESKTOP_ACTIVITY_UNAVAILABLE")
    return "Не удалось проверить задачи. Перезапуск отменён.";
  if (op.state === "unknown")
    return "Результат перезапуска пока неизвестен. Проверь приложение в Remote.";
  return "Перезапуск не завершился. Проверь приложение и вход в Windows через Remote.";
};
function Control({ machine, open }: { machine: Machine; open: boolean }) {
  const [state, setState] = useState<State>(),
    [error, setError] = useState(""),
    [confirm, setConfirm] = useState(false),
    [sending, setSending] = useState(false);
  const alive = useRef(true),
    sendingRef = useRef(false);
  const path = "/machines/" + encodeURIComponent(machine.id) + "/desktop";
  const refresh = async () => {
    const value = await api<State>(path);
    if (alive.current) setState(value);
  };
  useEffect(() => {
    alive.current = true;
    if (!open) {
      setConfirm(false);
      return;
    }
    let disposed = false,
      pending = false;
    const update = async () => {
      if (pending || disposed || document.visibilityState === "hidden") return;
      pending = true;
      try {
        const value = await api<State>(path);
        if (!disposed) {
          setState(value);
          setError("");
        }
      } catch (e) {
        if (!disposed) {
          setState(undefined);
          setError(messageOf(e));
        }
      } finally {
        pending = false;
      }
    };
    void update();
    const timer = window.setInterval(() => void update(), 4000);
    document.addEventListener("visibilitychange", update);
    return () => {
      disposed = true;
      alive.current = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", update);
    };
  }, [open, path]);
  const restarting =
    state?.operation?.kind === "restart" &&
    ["queued", "restarting"].includes(state.operation.state);
  const unavailable =
    !state || !state.activityKnown || state.activeTasks > 0 || restarting || sending;
  const restart = async () => {
    if (sendingRef.current || unavailable) return;
    sendingRef.current = true;
    setSending(true);
    setConfirm(false);
    setError("");
    try {
      const value = await api<State>(path + "/restart", {
        method: "POST",
        key: crypto.randomUUID(),
        body: { confirm: true },
      });
      if (alive.current) setState(value);
    } catch (e) {
      if (alive.current) setError(messageOf(e) + " Запрос автоматически не повторяется.");
      try {
        await refresh();
      } catch {
        /* The next read poll may recover; never replay the restart. */
      }
    } finally {
      sendingRef.current = false;
      if (alive.current) setSending(false);
    }
  };
  return (
    <section className="desktop-control" aria-label={"Codex на " + machine.name}>
      <div className="desktop-control-heading">
        <Icon name="remote" />
        <div>
          <strong>Codex на компьютере</strong>
          <span className="muted">{machine.name}</span>
        </div>
      </div>
      <p className="muted">
        {state?.activeTasks
          ? "Активных задач: " +
            state.activeTasks +
            ". Перезапуск будет доступен после их завершения."
          : state && !state.activityKnown
            ? "Проверка задач недоступна. Перезапуск пока заблокирован."
            : state
              ? "Закроет и заново откроет приложение в Windows."
              : "Проверяю состояние приложения…"}
      </p>
      {confirm ? (
        <div className="desktop-restart-confirm">
          <p>Перезапустить Codex на «{machine.name}»?</p>
          <div className="desktop-control-actions">
            <button type="button" className="secondary" onClick={() => setConfirm(false)}>
              Отмена
            </button>
            <button type="button" disabled={unavailable} onClick={() => void restart()}>
              Да, перезапустить
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="secondary desktop-restart-button"
          disabled={unavailable}
          onClick={() => setConfirm(true)}
        >
          <Icon name="refresh" />
          {sending || restarting ? "Перезапускаю…" : "Перезапустить Codex"}
        </button>
      )}
      <p className="desktop-operation small" role="status" aria-live="polite">
        {state ? operationText(state) : ""}
      </p>
      {error && (
        <p className="desktop-control-error small" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
export function DesktopControl({ machines, open }: { machines: Machine[]; open: boolean }) {
  return (
    <>
      {machines
        .filter((m) => m.desktopRestartAvailable)
        .map((machine) => (
          <Control key={machine.id} machine={machine} open={open} />
        ))}
    </>
  );
}
