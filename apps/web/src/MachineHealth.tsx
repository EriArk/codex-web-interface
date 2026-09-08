import type { MachineHealth as Health, MachinesOverview } from "@codex-web/shared";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, messageOf } from "./api";
import { CopyButton } from "./CopyButton";
import { Icon } from "./icons";
import "./machine-health.css";

const layers = {
  transport: "Связь",
  executable: "Codex",
  companion: "Companion",
  protocol: "Подключение Codex",
  account: "Вход в Codex",
  models: "Модели",
  remote: "Сеть Remote",
  gateway: "Шлюз Remote",
};
const labels: Record<string, string> = {
  REMOTE_GATEWAY_OK: "Отвечает",
  REMOTE_GATEWAY_UNAVAILABLE: "Шлюз на сервере не отвечает",
  LOCAL: "Локально",
  SSH_OK: "SSH доступен",
  SSH_HOST_KEY_FAILED: "Изменился ключ SSH",
  SSH_AUTH_FAILED: "SSH не принял ключ входа",
  SSH_TIMEOUT: "Истекло время ответа SSH",
  SSH_CLIENT_UNAVAILABLE: "SSH-клиент недоступен",
  SSH_NOT_CONFIGURED: "SSH не настроен",
  SSH_UNREACHABLE: "Компьютер не отвечает по SSH",
  CODEX_EXECUTABLE_OK: "Установлен",
  CODEX_EXECUTABLE_UNAVAILABLE: "Не удалось запустить Codex",
  CODEX_PROTOCOL_OK: "Отвечает",
  CODEX_PROTOCOL_UNAVAILABLE: "App Server не ответил",
  COMPANION_LAUNCH_OK: "Запуск подтверждён",
  COMPANION_LAUNCH_UNCONFIRMED: "Запуск через Companion не подтверждён",
  COMPANION_NOT_CONFIGURED: "Не используется",
  COMPANION_NOT_CHECKED: "Не проверен",
  CODEX_ACCOUNT_OK: "Вход выполнен",
  CODEX_ACCOUNT_UNKNOWN: "Не удалось проверить вход",
  CODEX_LOGIN_REQUIRED: "Нужен вход на компьютере",
  CODEX_MODELS_OK: "Доступны",
  CODEX_MODELS_UNAVAILABLE: "Не удалось получить модели",
  REMOTE_PORT_REACHABLE: "Порт доступен",
  REMOTE_UNREACHABLE: "Порт не отвечает",
  REMOTE_NOT_CONFIGURED: "Не настроен",
};
const date = (value: number) =>
  new Date(value).toLocaleString("ru", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
const gb = (value: number) =>
  new Intl.NumberFormat("ru", { maximumFractionDigits: 1 }).format(value / 1024 ** 3) + " ГБ";
export function MachineHealthPanel({
  open,
  onClose,
  onProject,
  onMaintenance,
}: {
  open: boolean;
  onClose: () => void;
  onProject: (id: string, remote: boolean) => void;
  onMaintenance?: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    [overview, setOverview] = useState<MachinesOverview | null>(null),
    [busy, setBusy] = useState(""),
    [error, setError] = useState("");
  const generation = useRef(0);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    let pending = false;
    const panel = dialog.current;
    panel?.showModal();
    panel?.focus({ preventScroll: true });
    setError("");
    const refresh = async () => {
      if (pending || document.visibilityState === "hidden") return;
      pending = true;
      try {
        const value = await api<MachinesOverview>("/machines/overview", {
          signal: controller.signal,
        });
        if (!controller.signal.aborted) setOverview(value);
      } catch (e) {
        if (!controller.signal.aborted) setError(messageOf(e));
      } finally {
        pending = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 30000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      controller.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
      panel?.close();
      generation.current++;
    };
  }, [open]);
  const check = async (id: string) => {
    if (busy) return;
    const current = ++generation.current;
    setBusy(id);
    setError("");
    try {
      const value = await api<MachinesOverview>(`/machines/${encodeURIComponent(id)}/diagnostics`, {
        method: "POST",
        body: {},
        timeoutMs: 45000,
      });
      if (current === generation.current) setOverview(value);
    } catch (e) {
      if (current === generation.current) setError(messageOf(e));
    } finally {
      if (current === generation.current) setBusy("");
    }
  };
  useEffect(() => {
    if (!open) setBusy("");
  }, [open]);
  const state = (m: Health) =>
    !m.probe || m.stale
      ? "unknown"
      : !m.probe.online
        ? "error"
        : m.probe.checks.some((c) => c.state === "error")
          ? "warning"
          : "ok";
  if (!open) return null;
  return createPortal(
    <dialog
      ref={dialog}
      className="machine-health-dialog"
      aria-label="Компьютеры"
      tabIndex={-1}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <header className="machine-health-heading">
        <Icon name="remote" />
        <strong>Компьютеры</strong>
        <button
          type="button"
          className="icon-button"
          aria-label="Закрыть компьютеры"
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </header>
      <div className="machine-health-scroll">
        {error && (
          <p className="notice" role="alert">
            {error}
          </p>
        )}
        {!overview && !error && (
          <p role="status">
            <span className="spinner" /> Загружаю…
          </p>
        )}
        <div className="machine-health-grid">
          {overview?.machines.map((m) => (
            <section key={m.id} className="machine-health-card" aria-label={m.name}>
              <div className="machine-health-title">
                <span className="machine-health-dot" data-state={state(m)} />
                <div>
                  <h2>{m.name}</h2>
                  <small>
                    {m.os} · {m.transport}
                  </small>
                </div>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Проверить ${m.name}`}
                  disabled={!!busy || m.busy}
                  onClick={() => void check(m.id)}
                >
                  {busy === m.id || m.busy ? <span className="spinner" /> : <Icon name="refresh" />}
                </button>
              </div>
              <p className="machine-health-time">
                {m.probe
                  ? `${m.stale ? "Прошлая проверка" : "Проверено"}: ${date(m.probe.checkedAt)}`
                  : "Ещё не проверен"}
                {m.lastSeenAt && (!m.probe?.online || m.stale)
                  ? ` · Был на связи ${date(m.lastSeenAt)}`
                  : ""}
              </p>
              <div className="machine-health-activity">
                <span>Сайт: {m.active.web}</span>
                <span>Компьютер: {m.active.external}</span>
                {m.active.unknown > 0 && <span>Статус неизвестен: {m.active.unknown}</span>}
                <span className="muted">
                  Управление: {m.owner === "desktop" ? "компьютер" : "сайт"}
                </span>
              </div>
              {m.probe && (
                <>
                  <dl className="machine-health-checks">
                    {m.probe.checks.map((c) => (
                      <div key={c.layer}>
                        <dt>{layers[c.layer]}</dt>
                        <dd data-state={c.state}>
                          {labels[c.code] ?? "Нужна проверка"}
                          {c.layer === "executable" && m.probe?.codexVersion
                            ? ` · ${m.probe.codexVersion}`
                            : ""}
                        </dd>
                      </div>
                    ))}
                  </dl>
                  {m.probe.metrics && (
                    <div className="machine-health-metrics">
                      {m.probe.metrics.memoryTotal !== undefined &&
                        m.probe.metrics.memoryAvailable !== undefined && (
                          <span>
                            Память: {gb(m.probe.metrics.memoryAvailable)} свободно из{" "}
                            {gb(m.probe.metrics.memoryTotal)}
                          </span>
                        )}
                      {m.probe.metrics.diskAvailable !== undefined &&
                        m.probe.metrics.diskTotal !== undefined && (
                          <span>
                            Диск проекта: {gb(m.probe.metrics.diskAvailable)} из{" "}
                            {gb(m.probe.metrics.diskTotal)}
                          </span>
                        )}
                      {m.probe.metrics.cpuPercent !== undefined && (
                        <span>CPU: {Math.round(m.probe.metrics.cpuPercent)}%</span>
                      )}
                      {m.probe.metrics.bootedAt !== undefined && (
                        <span>Компьютер запущен: {date(m.probe.metrics.bootedAt)}</span>
                      )}
                    </div>
                  )}
                  <details className="machine-health-details">
                    <summary>
                      Диагностические коды
                      <CopyButton
                        text={JSON.stringify(
                          { name: m.name, os: m.os, ...m.probe, active: m.active },
                          null,
                          2,
                        )}
                        label="Копировать диагностику"
                      />
                    </summary>
                    <ul>
                      {m.probe.checks.map((c) => (
                        <li key={c.layer}>
                          <code>{c.code}</code>
                        </li>
                      ))}
                    </ul>
                  </details>
                </>
              )}
              <div className="machine-health-projects">
                {m.projects.map((p) => (
                  <div key={p.id}>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => onProject(p.id, false)}
                    >
                      <Icon name="folder" />
                      {p.name}
                    </button>
                    {p.remoteAvailable && (
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={`Remote: ${p.name}`}
                        onClick={() => onProject(p.id, true)}
                      >
                        <Icon name="remote" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
        {overview && (
          <footer className="machine-health-footer">
            <span>Hub запущен: {date(overview.hub.startedAt)}</span>
            <span>Сервер запущен: {date(overview.hub.hostStartedAt)}</span>
            {onMaintenance && (
              <button type="button" className="secondary" onClick={onMaintenance}>
                Управление Codex
              </button>
            )}
          </footer>
        )}
      </div>
    </dialog>,
    document.body,
  );
}
