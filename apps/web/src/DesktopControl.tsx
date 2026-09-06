import { useEffect, useRef, useState } from "react";
import { api, messageOf } from "./api";
import { Icon } from "./icons";
import type { Machine } from "./types";
import "./desktopControl.css";

interface State {
  running: boolean;
  activityKnown: boolean;
  activeTasks: number;
  client?: "web" | "desktop";
  operation: null | { id: string; kind: string; state: string; code: string; requestedAt: number };
}
const operationText = (state: State) => {
  const op = state.operation;
  if (!op || !["restart", "forcerestart"].includes(op.kind)) return "";
  if (["queued", "restarting"].includes(op.state)) return "Перезапускаю Codex…";
  if (op.state === "completed") return "Codex снова открыт на компьютере.";
  if (op.code === "DESKTOP_BUSY") return "Началась задача. Перезапуск отменён.";
  if (op.code === "DESKTOP_ACTIVITY_UNAVAILABLE")
    return "Не удалось проверить задачи. Перезапуск отменён.";
  if (op.state === "unknown")
    return "Результат перезапуска пока неизвестен. Проверь Codex в Remote.";
  return "Перезапуск не завершился. Проверь Codex и вход в Windows через Remote.";
};
function Control({ machine, open }: { machine: Machine; open: boolean }) {
  const [state, setState] = useState<State>(),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [confirm, setConfirm] = useState<false | "restart" | "force">(false),
    [sending, setSending] = useState(false);
  const alive = useRef(true),
    sendingRef = useRef(false);
  const base = "/machines/" + encodeURIComponent(machine.id),
    path = base + "/desktop";
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
        if (!disposed) setState(value);
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
    !!state?.operation &&
    ["restart", "forcerestart"].includes(state.operation.kind) &&
    ["queued", "restarting"].includes(state.operation.state);
  const unavailable =
    !state || !state.activityKnown || state.activeTasks > 0 || restarting || sending;
  const run = async (kind: "restart" | "force" | "client") => {
    if (sendingRef.current || restarting || (kind === "restart" && unavailable)) return;
    sendingRef.current = true;
    setSending(true);
    setConfirm(false);
    setError("");
    setNotice("");
    try {
      if (kind === "client") {
        const client = state?.client === "desktop" ? "web" : "desktop";
        await api(base + "/client", { method: "POST", key: crypto.randomUUID(), body: { client } });
        if (alive.current) {
          setState((v) => (v ? { ...v, client } : v));
          setNotice(client === "desktop" ? "Компьютер освобождён." : "Можно продолжать на сайте.");
        }
      } else {
        const value = await api<State>(path + (kind === "force" ? "/force-restart" : "/restart"), {
          method: "POST",
          key: crypto.randomUUID(),
          body: kind === "force" ? { confirmStopTasks: true } : { confirm: true },
        });
        if (alive.current) setState(value);
      }
    } catch (e) {
      if (alive.current) setError(messageOf(e));
      try {
        await refresh();
      } catch {
        /* Read-only polling may recover. Never replay the action. */
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
      <div className="desktop-control-actions">
        <span className="small muted">
          {state?.client === "desktop" ? "Управление: компьютер" : "Управление: сайт"}
        </span>
        <button
          type="button"
          className="secondary"
          disabled={sending || restarting}
          onClick={() => void run("client")}
        >
          {state?.client === "desktop" ? "Продолжить на сайте" : "Работать с компьютера"}
        </button>
      </div>
      <p className="muted">
        {state?.activeTasks
          ? "Активных задач: " + state.activeTasks
          : state && !state.activityKnown
            ? "Проверка задач недоступна."
            : state
              ? "Приложение в Windows"
              : "Проверяю состояние приложения…"}
      </p>
      {confirm ? (
        <div className="desktop-restart-confirm">
          <p>
            {confirm === "force"
              ? "Остановить задачи и жёстко перезапустить Codex?"
              : "Перезапустить Codex на «" + machine.name + "»?"}
          </p>
          <div className="desktop-control-actions">
            <button type="button" className="secondary" onClick={() => setConfirm(false)}>
              Отмена
            </button>
            <button
              type="button"
              disabled={confirm === "restart" ? unavailable : sending || restarting}
              onClick={() => void run(confirm)}
            >
              {confirm === "force" ? "Остановить и перезапустить" : "Да, перезапустить"}
            </button>
          </div>
        </div>
      ) : (
        <div className="desktop-maintenance-actions">
          <button
            type="button"
            className="secondary desktop-restart-button"
            disabled={unavailable}
            onClick={() => setConfirm("restart")}
          >
            <Icon name="refresh" />
            {sending || restarting ? "Перезапускаю…" : "Перезапустить Codex"}
          </button>
          <button
            type="button"
            className="text-button"
            disabled={sending || restarting}
            onClick={() => setConfirm("force")}
          >
            Жёстко перезапустить Codex
          </button>
        </div>
      )}
      <p className="desktop-operation small" role="status" aria-live="polite">
        {notice || (state ? operationText(state) : "")}
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
