import type {
  DeviceAction,
  DeviceInfo,
  DeviceSnapshot,
  DeviceTerminalInfo,
} from "@codex-web/shared";
import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { DeviceTerminal } from "./DeviceTerminal";
import { Icon } from "./icons";
import "./devices.css";

const bytes = (v: number) =>
  v >= 1024 ** 4
    ? `${(v / 1024 ** 4).toFixed(1)} ТБ`
    : v >= 1024 ** 3
      ? `${(v / 1024 ** 3).toFixed(1)} ГБ`
      : `${Math.round(v / 1024 ** 2)} МБ`;
const duration = (seconds: number) =>
  seconds >= 86400
    ? `${Math.floor(seconds / 86400)} дн. ${Math.floor((seconds % 86400) / 3600)} ч.`
    : `${Math.floor(seconds / 3600)} ч. ${Math.floor((seconds % 3600) / 60)} мин.`;
export default function DeviceWorkspace({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null),
    actionDialog = useRef<HTMLDialogElement>(null);
  const [devices, setDevices] = useState<DeviceInfo[]>([]),
    [selected, setSelected] = useState(() => {
      try {
        return localStorage.getItem("codex-device") ?? "";
      } catch {
        return "";
      }
    });
  const [snapshot, setSnapshot] = useState<DeviceSnapshot>(),
    [sessions, setSessions] = useState<DeviceTerminalInfo[]>([]),
    [terminal, setTerminal] = useState("");
  const [page, setPage] = useState<"info" | "terminal">("info"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [refresh, setRefresh] = useState(0),
    [action, setAction] = useState<"restart" | "shutdown" | "mount" | null>(null);
  const [source, setSource] = useState(""),
    [mountName, setMountName] = useState(""),
    [protocol, setProtocol] = useState<"smb" | "nfs">("smb"),
    [credentials, setCredentials] = useState(true);
  const pending = useRef<{ key: string; device: string; action: DeviceAction } | null>(null);
  const selection = useRef(selected);
  selection.current = selected;
  const current = devices.find((d) => d.id === selected);
  useEffect(() => {
    if (action) {
      actionDialog.current?.showModal();
      actionDialog.current?.focus();
    }
    return () => actionDialog.current?.close();
  }, [action]);
  useEffect(() => {
    dialog.current?.showModal();
    dialog.current?.focus();
    return () => dialog.current?.close();
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void api<{ devices: DeviceInfo[] }>("/devices", { signal: controller.signal })
      .then((r) => {
        setDevices(r.devices);
        setSelected((v) => (r.devices.some((d) => d.id === v) ? v : (r.devices[0]?.id ?? "")));
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    setSnapshot(undefined);
    setSessions([]);
    setTerminal("");
    setAction(null);
    setError("");
    if (!selected) return;
    try {
      localStorage.setItem("codex-device", selected);
    } catch {}
    const controller = new AbortController();
    const read = () => {
      if (document.hidden) return;
      void api<DeviceSnapshot>(`/devices/${selected}/snapshot`, {
        signal: controller.signal,
        timeoutMs: 20000,
      })
        .then(setSnapshot)
        .catch((e) => {
          if (!controller.signal.aborted) setError(e.message);
        });
    };
    read();
    const timer = setInterval(read, 30000);
    document.addEventListener("visibilitychange", read);
    void api<{ terminals: DeviceTerminalInfo[] }>(`/devices/${selected}/terminals`, {
      signal: controller.signal,
    })
      .then((r) => {
        setSessions(r.terminals);
        const open = r.terminals.find((t) => t.state === "open");
        setTerminal(open?.id ?? "");
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => {
      controller.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", read);
    };
  }, [selected]);
  useEffect(() => {
    if (!selected || refresh === 0) return;
    const controller = new AbortController();
    void Promise.all([
      api<DeviceSnapshot>(`/devices/${selected}/snapshot`, { signal: controller.signal }),
      api<{ terminals: DeviceTerminalInfo[] }>(`/devices/${selected}/terminals`, {
        signal: controller.signal,
      }),
    ])
      .then(([s, t]) => {
        setSnapshot(s);
        setSessions(t.terminals);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [refresh, selected]);
  const create = async (value: DeviceAction) => {
    if (!current || busy) return;
    const id = current.id;
    if (
      !pending.current ||
      pending.current.device !== id ||
      JSON.stringify(pending.current.action) !== JSON.stringify(value)
    )
      pending.current = { device: id, action: value, key: crypto.randomUUID() };
    setBusy(true);
    setError("");
    try {
      const result = await api<DeviceTerminalInfo>(`/devices/${id}/terminals`, {
        method: "POST",
        body: value,
        key: pending.current.key,
        timeoutMs: 20000,
      });
      pending.current = null;
      if (selection.current === id) {
        setSessions((v) => [result, ...v.filter((t) => t.id !== result.id)].slice(0, 12));
        setTerminal(result.id);
        setPage("terminal");
        setAction(null);
      }
    } catch (e) {
      if (selection.current === id) setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const end = async () => {
    if (!terminal || busy) return;
    setBusy(true);
    setError("");
    try {
      await api(`/device-terminals/${terminal}`, { method: "DELETE" });
      setRefresh((v) => v + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <dialog
      className="devices-workspace"
      ref={dialog}
      tabIndex={-1}
      aria-label="Устройства"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <header className="devices-heading">
        <Icon name="terminal" />
        <h2>Устройства</h2>
        <button
          type="button"
          className="icon-button"
          aria-label="Закрыть устройства"
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </header>
      <nav className="device-picker" aria-label="Выбор устройства">
        {devices.map((d) => (
          <button
            type="button"
            key={d.id}
            className={d.id === selected ? "selected" : ""}
            aria-pressed={d.id === selected}
            disabled={busy}
            onClick={() => {
              setSelected(d.id);
              setPage("info");
            }}
          >
            <Icon name={d.platform === "windows" ? "remote" : "server"} />
            <span>
              {d.name}
              <small>
                {d.platform === "windows"
                  ? "Windows"
                  : d.platform === "linux"
                    ? "Linux"
                    : "Android"}
              </small>
            </span>
          </button>
        ))}
      </nav>
      {error && (
        <div className="device-error" role="alert">
          {error}
        </div>
      )}
      {!devices.length ? (
        <p className="device-empty">Устройства пока не настроены.</p>
      ) : (
        <>
          <nav className="device-mobile-tabs" aria-label="Вид устройства">
            <button type="button" aria-pressed={page === "info"} onClick={() => setPage("info")}>
              Система
            </button>
            <button
              type="button"
              aria-pressed={page === "terminal"}
              onClick={() => setPage("terminal")}
            >
              Терминал
            </button>
          </nav>
          <div className="device-layout" data-page={page}>
            <section className="device-system">
              <div className="device-section-heading">
                <h3>{current?.name}</h3>
                <span className={snapshot?.online ? "online" : ""}>
                  {snapshot ? (snapshot.online ? "В сети" : "Недоступно") : "Проверяем…"}
                </span>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Обновить устройство"
                  onClick={() => setRefresh((v) => v + 1)}
                >
                  <Icon name="refresh" size={18} />
                </button>
              </div>
              {snapshot?.online ? (
                <>
                  <p className="device-os">
                    {snapshot.os}
                    <small>
                      {snapshot.hostname} · {snapshot.architecture}
                    </small>
                  </p>
                  <dl className="device-specs">
                    <div>
                      <dt>Процессор</dt>
                      <dd>
                        {snapshot.cpu || "Нет данных"}
                        {snapshot.cores ? ` · ${snapshot.cores} потоков` : ""}
                      </dd>
                    </div>
                    {snapshot.cpuPercent !== undefined && (
                      <div>
                        <dt>Загрузка CPU</dt>
                        <dd>{Math.round(snapshot.cpuPercent)}%</dd>
                      </div>
                    )}
                    {snapshot.load1 !== undefined && (
                      <div>
                        <dt>Нагрузка · 1 мин</dt>
                        <dd>{snapshot.load1.toFixed(2)}</dd>
                      </div>
                    )}
                    {snapshot.uptimeSeconds !== undefined && (
                      <div>
                        <dt>Без перезагрузки</dt>
                        <dd>{duration(snapshot.uptimeSeconds)}</dd>
                      </div>
                    )}
                  </dl>
                  {snapshot.memoryTotal !== undefined && snapshot.memoryAvailable !== undefined && (
                    <div className="device-meter">
                      <span>
                        Память{" "}
                        <b>
                          {bytes(snapshot.memoryTotal - snapshot.memoryAvailable)} /{" "}
                          {bytes(snapshot.memoryTotal)}
                        </b>
                      </span>
                      <meter
                        min={0}
                        max={snapshot.memoryTotal}
                        value={snapshot.memoryTotal - snapshot.memoryAvailable}
                      />
                    </div>
                  )}
                  <h4>Диски</h4>
                  {snapshot.disks.map((d) => (
                    <div className="device-meter" key={`${d.mount}:${d.name}`}>
                      <span title={d.name}>
                        {d.mount}
                        <b>
                          {bytes(d.total - d.available)} / {bytes(d.total)}
                        </b>
                      </span>
                      <meter min={0} max={d.total} value={d.total - d.available} />
                    </div>
                  ))}
                  <h4>Температура</h4>
                  {snapshot.temperatures.length ? (
                    snapshot.temperatures.map((t) => (
                      <div className="device-sensor" key={t.name}>
                        <span>{t.name}</span>
                        <b>{t.celsius.toFixed(1)} °C</b>
                      </div>
                    ))
                  ) : (
                    <p className="device-muted">Датчики недоступны.</p>
                  )}
                </>
              ) : (
                snapshot && <p>{snapshot.error}</p>
              )}
              <div className="device-actions">
                {current?.mounts && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setAction("mount");
                      setMountName(current.platform === "windows" ? "Z" : "share");
                    }}
                  >
                    <Icon name="folder" size={18} />
                    Сетевой диск
                  </button>
                )}
                {current?.power && (
                  <>
                    <button type="button" disabled={busy} onClick={() => setAction("restart")}>
                      <Icon name="refresh" size={18} />
                      Перезагрузка
                    </button>
                    <button type="button" disabled={busy} onClick={() => setAction("shutdown")}>
                      <Icon name="power" size={18} />
                      Выключение
                    </button>
                  </>
                )}
              </div>
            </section>
            <section className="device-console">
              <div className="device-console-heading">
                <select
                  aria-label="Сессия терминала"
                  value={terminal}
                  onChange={(e) => setTerminal(e.target.value)}
                >
                  <option value="">Терминалы</option>
                  {sessions.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.title} ·{" "}
                      {new Date(t.createdAt).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                      {t.state === "closed" ? " · завершён" : ""}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="icon-button"
                  disabled={busy}
                  aria-label="Новый терминал"
                  onClick={() => void create({ kind: "shell" })}
                >
                  <Icon name="plus" />
                </button>
                {sessions.find((t) => t.id === terminal)?.state === "open" && (
                  <button
                    type="button"
                    className="icon-button"
                    disabled={busy}
                    aria-label="Завершить терминал"
                    onClick={() => void end()}
                  >
                    <Icon name="stop" size={18} />
                  </button>
                )}
              </div>
              {terminal ? (
                <DeviceTerminal id={terminal} onExit={() => setRefresh((v) => v + 1)} />
              ) : (
                <div className="device-terminal-empty">
                  <Icon name="terminal" size={40} />
                  <p>{current?.platform === "windows" ? "PowerShell на ПК" : "Терминал сервера"}</p>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void create({ kind: "shell" })}
                  >
                    {busy ? "Открываем…" : "Открыть терминал"}
                  </button>
                </div>
              )}
            </section>
          </div>
        </>
      )}
      {action && current && (
        <dialog
          className="device-action-backdrop"
          ref={actionDialog}
          tabIndex={-1}
          aria-label="Действие устройства"
          onCancel={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!busy) setAction(null);
          }}
        >
          <form
            className="device-action-dialog"
            onSubmit={(e) => {
              e.preventDefault();
              void create(
                action === "mount"
                  ? {
                      kind: "mount",
                      protocol,
                      source,
                      name: mountName,
                      credentials,
                      confirmation: current.name,
                    }
                  : { kind: action, confirmation: current.name },
              );
            }}
          >
            <h3>
              {action === "mount"
                ? "Подключить сетевой диск"
                : action === "restart"
                  ? "Перезагрузить"
                  : "Выключить"}{" "}
              · {current.name}
            </h3>
            {action === "mount" ? (
              <>
                <label>
                  Протокол
                  <select
                    value={protocol}
                    onChange={(e) => setProtocol(e.target.value as "smb" | "nfs")}
                  >
                    <option value="smb">SMB</option>
                    {current.platform !== "windows" && <option value="nfs">NFS</option>}
                  </select>
                </label>
                <label>
                  Адрес
                  <input
                    required
                    value={source}
                    placeholder={protocol === "smb" ? "//server/share" : "server:/path"}
                    onChange={(e) => setSource(e.target.value)}
                  />
                </label>
                <label>
                  {current.platform === "windows" ? "Буква диска" : "Папка в ~/mnt"}
                  <input
                    required
                    value={mountName}
                    onChange={(e) => setMountName(e.target.value)}
                  />
                </label>
                {protocol === "smb" && (
                  <label className="device-checkbox">
                    <input
                      type="checkbox"
                      checked={credentials}
                      onChange={(e) => setCredentials(e.target.checked)}
                    />
                    Запросить имя и пароль
                  </label>
                )}
                {current.platform === "windows" && <p>Диск подключится для удалённой сессии ПК.</p>}
              </>
            ) : (
              <p>Работающие программы и задачи на этом устройстве будут остановлены.</p>
            )}
            <footer>
              <button type="button" disabled={busy} onClick={() => setAction(null)}>
                Отмена
              </button>
              <button
                type="submit"
                className={action === "mount" ? "primary" : "danger"}
                disabled={busy}
              >
                {busy
                  ? "Выполняем…"
                  : action === "mount"
                    ? "Подключить"
                    : action === "restart"
                      ? "Перезагрузить"
                      : "Выключить"}
              </button>
            </footer>
          </form>
        </dialog>
      )}
    </dialog>
  );
}
