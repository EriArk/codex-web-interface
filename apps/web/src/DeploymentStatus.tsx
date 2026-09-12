import { useEffect, useState } from "react";
import { api } from "./api";
import { Icon } from "./icons";
import "./deployment-status.css";

type Release = {
  kind?: string;
  revision?: string;
  state?: string;
  startedAt?: number;
  installedAt?: number;
  code?: string;
};
type Status = {
  separated: boolean;
  engineRevision: string;
  schema: number;
  web: Release | null;
  maintenance: Release | null;
  blockers: { kind: string; count: number; label: string }[];
};
const names: Record<string, string> = {
  checking: "Проверяется",
  staged: "Подготовлено",
  waiting: "Ждёт установки",
  installing: "Устанавливается",
  installed: "Установлено",
  failed: "Установка не прошла",
  rolled_back: "Возвращена предыдущая версия",
};
export function DeploymentStatus({ open }: { open: boolean }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    if (!open) return;
    const abort = new AbortController();
    const load = () =>
      void api<Status>("/deployment", { signal: abort.signal })
        .then((value) => {
          if (!abort.signal.aborted) {
            setStatus(value);
            setUnavailable(false);
          }
        })
        .catch(() => {
          if (!abort.signal.aborted) setUnavailable(true);
        });
    load();
    const timer = setInterval(load, 10000);
    return () => {
      abort.abort();
      clearInterval(timer);
    };
  }, [open]);
  const pending =
    status?.maintenance &&
    ["staged", "waiting", "installing"].includes(status.maintenance.state ?? "");
  return (
    <details className="deployment-status">
      <summary>
        <Icon name="refresh" size={18} />
        <span>Обновления</span>
        <small>
          {pending ? "Ожидает" : status?.web?.state === "installed" ? "Установлено" : ""}
        </small>
      </summary>
      {unavailable && <p role="status">Состояние обновления пока недоступно.</p>}
      {status && (
        <>
          <p className="muted">
            {status.separated
              ? "Сайт обновляется независимо от работы Codex, GPT и терминалов."
              : "Обновление движка требует завершения активной работы."}
          </p>
          {[status.web, status.maintenance]
            .filter((r): r is Release => !!r)
            .map((release) => (
              <div className="deployment-release" key={release.kind}>
                <div>
                  <strong>{release.kind === "web" ? "Интерфейс" : "Движок"}</strong>
                  <code>{release.revision?.slice(0, 8)}</code>
                </div>
                <span>{names[release.state ?? ""] ?? "Состояние неизвестно"}</span>
                {release.installedAt ? (
                  <small>{new Date(release.installedAt).toLocaleString("ru")}</small>
                ) : pending && release.startedAt ? (
                  <small>
                    Ожидание: {Math.max(0, Math.floor((Date.now() - release.startedAt) / 60000))}{" "}
                    мин.
                  </small>
                ) : null}
              </div>
            ))}
          {pending && !!status.blockers.length && (
            <ul>
              {status.blockers.map((b) => (
                <li key={b.kind}>
                  {b.label} · {b.count}
                </li>
              ))}
            </ul>
          )}
          {pending && status.blockers.some((b) => b.kind === "terminal") && (
            <p>Закрой ненужный терминал в «Устройствах», когда его работа закончится.</p>
          )}
          <small className="muted">Движок {status.engineRevision.slice(0, 8)}</small>
        </>
      )}
    </details>
  );
}
