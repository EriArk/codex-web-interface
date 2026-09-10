import type { NotebookLink } from "@codex-web/shared";
import { useCallback, useEffect, useState } from "react";
import { api, messageOf } from "./api";
import { Icon } from "./icons";
import "./bridge-doctor.css";

type Data = {
  association: {
    projectId: string;
    threadId: string | null;
    state: string;
    enabled: boolean;
    revision: number;
  };
  projects: { id: string; name: string }[];
  threads: { id: string; title: string }[];
  incidents: {
    projectId: string;
    id: string;
    firstSeen: number;
    lastSeen: number;
    occurrences: number;
    state: string;
    delivery: string;
    threadId?: string;
    turnId?: string;
    message?: string;
    diagnostics: {
      code: string;
      state: string;
      revision: string;
      bridgeVersion: string;
      protocol: number | null;
      capabilities: Record<string, boolean>;
    };
    evidence?: { kind: string };
  }[];
};
export function BridgeDoctorPanel({
  open,
  onTarget,
}: {
  open: boolean;
  onTarget?: (target: NotebookLink) => void;
}) {
  const [data, setData] = useState<Data | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [binding, setBinding] = useState("");
  const refresh = useCallback(async () => {
    const result = await api<Data>("/gpt/doctor");
    if (result.association && Array.isArray(result.incidents)) setData(result);
  }, []);
  useEffect(() => {
    if (!open) return;
    let active = true,
      reading = false;
    const poll = async () => {
      if (reading || document.hidden) return;
      reading = true;
      try {
        const result = await api<Data>("/gpt/doctor");
        if (active && result.association && Array.isArray(result.incidents)) {
          setData(result);
          setError("");
        }
      } catch (e) {
        if (active) setError(messageOf(e));
      } finally {
        reading = false;
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 15000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [open]);
  const action = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };
  if (!data) return error ? <p className="form-error">{error}</p> : null;
  const count = data.incidents.filter((i) => i.state === "open").length;
  const configure = (patch: { enabled?: boolean; projectId?: string }) =>
    action(() =>
      api("/gpt/doctor/settings", {
        method: "POST",
        body: {
          enabled: data.association.enabled,
          projectId: data.association.projectId,
          revision: data.association.revision,
          ...patch,
        },
      }),
    );
  const status: Record<string, string> = {
    open: "Нужна проверка",
    recovered: "Связь восстановлена",
    dismissed: "Скрыт",
    pending: "Ожидает свободного Codex",
    dispatching: "Отправляется",
    sent: "Передано Codex",
    unknown: "Нужна проверка отправки",
    skipped: "Диагностика не запускалась",
  };
  return (
    <details className="bridge-doctor-panel">
      <summary>
        <Icon name="activity" size={18} />
        Bridge Doctor{count > 0 && <span className="badge">{count}</span>}
      </summary>
      <div className="doctor-controls">
        <label>
          <input
            type="checkbox"
            aria-label="Автодиагностика GPT"
            checked={data.association.enabled}
            disabled={busy}
            onChange={(e) => void configure({ enabled: e.target.checked })}
          />
          Автодиагностика GPT
        </label>
        <label>
          Проект диагностики
          <select
            aria-label="Проект Bridge Doctor"
            value={data.association.projectId}
            disabled={busy || data.association.state !== "empty"}
            onChange={(e) => void configure({ projectId: e.target.value })}
          >
            <option value="">Выбрать проект</option>
            {data.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <small>Только анализ. Исправления и перезапуски — по твоему запросу.</small>
        {data.association.state === "unknown" && (
          <div className="form-error">
            <p>Создание чата не подтверждено. Выбери уже созданный отдельный чат.</p>
            <select
              aria-label="Существующий чат Bridge Doctor"
              value={binding}
              onChange={(e) => setBinding(e.target.value)}
            >
              <option value="">Выбрать чат</option>
              {data.threads.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={!binding || busy}
              onClick={() =>
                void action(() =>
                  api("/gpt/doctor/bind", { method: "POST", body: { threadId: binding } }),
                )
              }
            >
              Подключить чат
            </button>
          </div>
        )}
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="doctor-incidents">
        {!data.incidents.length && <p className="muted">Инцидентов пока нет.</p>}
        {data.incidents.map((i) => (
          <details key={i.id} className="doctor-incident">
            <summary>
              <span>
                {status[i.state]}
                <small>
                  {new Date(i.firstSeen).toLocaleString("ru")} · {i.occurrences}
                </small>
              </span>
              <Icon name="chevron" size={16} />
            </summary>
            <p>{i.diagnostics.code}</p>
            <p className="muted">{status[i.delivery]}</p>
            {i.message && <p>{i.message}</p>}
            <dl>
              <dt>Bridge</dt>
              <dd>
                {i.diagnostics.bridgeVersion} · protocol {i.diagnostics.protocol ?? "?"}
              </dd>
              <dt>Версия сайта</dt>
              <dd>{i.diagnostics.revision}</dd>
            </dl>
            <div className="doctor-capabilities">
              {Object.entries(i.diagnostics.capabilities).map(([key, ok]) => (
                <span key={key}>
                  <Icon name={ok ? "check" : "close"} size={13} />
                  {key}
                </span>
              ))}
            </div>
            {i.evidence?.kind === "redacted-layout" && (
              <img
                src={`/api/gpt/doctor/${i.id}/evidence`}
                alt="Структура интерфейса, личное содержимое скрыто"
                loading="lazy"
              />
            )}
            <div className="doctor-actions">
              {i.threadId && onTarget && (
                <button
                  type="button"
                  className="secondary"
                  onClick={() =>
                    onTarget({
                      availability: "available",
                      client: "codex",
                      kind: "thread",
                      id: i.threadId!,
                      threadId: i.threadId,
                      projectId: i.projectId,
                      ...(i.turnId ? { turnId: i.turnId } : {}),
                      title: "Bridge Doctor",
                    })
                  }
                >
                  <Icon name="chat" />
                  Диагностика Codex
                </button>
              )}
              {i.state === "open" && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void action(() =>
                      api(`/gpt/doctor/${i.id}/dismiss`, { method: "POST", body: {} }),
                    )
                  }
                >
                  Скрыть
                </button>
              )}
            </div>
          </details>
        ))}
      </div>
    </details>
  );
}
