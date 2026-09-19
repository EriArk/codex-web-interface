import type { GptConnection, NotebookLink } from "@codex-web/shared";
import { useEffect, useRef, useState } from "react";
import { AccountControls } from "./AccountControls";
import { AppearanceSettings } from "./AppearanceSettings";
import { pageWorkspace } from "./accountStorage";
import { api, messageOf } from "./api";
import { BridgeDoctorPanel } from "./BridgeDoctorPanel";
import { DeploymentStatus } from "./DeploymentStatus";
import { DesktopControl } from "./DesktopControl";
import { EntityArchive } from "./EntityMenu";
import { Icon } from "./icons";
import { SpeechSettings } from "./MessageSpeech";
import { NativeInventory } from "./NativeInventory";
import { Notifications } from "./Notifications";
import { SettingsSections } from "./SettingsSections";
import { StorageUsage } from "./StorageUsage";
import { TeamGpt } from "./TeamGpt";
import { TeamMachines } from "./TeamMachines";
import type { Machine, Project, Session, Theme } from "./types";
import { UsageLimits } from "./UsageLimits";
import { UsageLimitsProvider } from "./UsageLimitsState";
import { useProjectSwipe } from "./useProjectSwipe";

export const gptSettingsChanged = "codex-gpt-settings-changed";

function GptConnectionSettings({ visible }: { visible: boolean }) {
  const [status, setStatus] = useState<GptConnection | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const sequence = useRef(0);
  useEffect(() => {
    if (!visible) return;
    const abort = new AbortController();
    const current = ++sequence.current;
    void api<GptConnection>("/gpt/status", { signal: abort.signal })
      .then((value) => {
        if (!abort.signal.aborted && current === sequence.current) {
          setStatus(value);
          setError("");
        }
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(messageOf(e));
      });
    return () => abort.abort();
  }, [visible]);
  const check = async () => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    const current = ++sequence.current;
    try {
      const next = await api<GptConnection>("/gpt/reconnect", { method: "POST" });
      if (current === sequence.current) setStatus(next);
      window.dispatchEvent(new Event(gptSettingsChanged));
    } catch (e) {
      setError(messageOf(e));
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  return (
    <section className="gpt-connection-settings" aria-label="Состояние GPT">
      <p role="status">{error || status?.message || "Проверяем подключение GPT…"}</p>
      <button type="button" className="secondary" disabled={busy} onClick={() => void check()}>
        <Icon name="refresh" />
        {busy ? "Проверяем…" : "Перепроверить подключение"}
      </button>
      <a
        className="primary"
        href={
          status?.connectUrl === "/gpt-connect?runtime=native"
            ? "/gpt-connect?runtime=native&immersive=1"
            : "/gpt-connect?immersive=1"
        }
        target="_blank"
        rel="noopener noreferrer"
      >
        <Icon name="remote" />
        {status?.connectUrl === "/gpt-connect?runtime=native"
          ? "Открыть клиент ChatGPT"
          : "Браузер ChatGPT на сервере"}
      </a>
    </section>
  );
}

export function WorkspaceSettings({
  open,
  onClose,
  machines,
  project,
  threadId,
  theme,
  onTheme,
  onSession,
  onLogout,
  onMachines,
  onActivity,
  onTarget,
  onRefreshCodex,
}: {
  open: boolean;
  onClose: () => void;
  machines: Machine[];
  project?: Project;
  threadId: string;
  theme: Theme;
  onTheme: (theme: Theme) => void;
  onSession: (session: Session) => void;
  onLogout: () => void;
  onMachines: () => void;
  onActivity: () => void;
  onTarget: (target: NotebookLink) => void;
  onRefreshCodex: () => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [refreshing, setRefreshing] = useState("");
  const [notice, setNotice] = useState("");
  const running = useRef(false);
  useProjectSwipe(dialog, open, onClose, "close");
  useEffect(() => {
    const panel = dialog.current;
    if (open && panel) {
      panel.showModal();
      panel.focus({ preventScroll: true });
    } else panel?.close();
  }, [open]);
  const refresh = async (client: "codex" | "gpt") => {
    if (running.current) return;
    running.current = true;
    setRefreshing(client);
    setNotice("");
    try {
      if (client === "codex") await onRefreshCodex();
      else {
        await Promise.all([api("/gpt/conversations?offset=0"), api("/gpt/projects")]);
        window.dispatchEvent(new Event(gptSettingsChanged));
      }
      setNotice("Списки обновлены.");
    } catch (e) {
      setNotice(messageOf(e));
    } finally {
      running.current = false;
      setRefreshing("");
    }
  };
  return (
    <dialog
      ref={dialog}
      tabIndex={-1}
      className="settings-dialog settings-browser"
      aria-label="Настройки"
      onCancel={onClose}
    >
      <UsageLimitsProvider machines={machines} open={open}>
        <SettingsSections
          open={open}
          onClose={onClose}
          overview={(visible) => <UsageLimits machines={machines} open={visible} />}
          sections={{
            appearance: () => <AppearanceSettings theme={theme} onTheme={onTheme} />,
            sound: (visible) => (
              <>
                <SpeechSettings />
                <Notifications visible={visible} />
              </>
            ),
            connections: (visible) => (
              <>
                <section className="settings-service" aria-label="Подключение Codex">
                  <h4>
                    <Icon name="repository" />
                    Codex
                  </h4>
                  <UsageLimits machines={machines} open={visible} />
                  {project && <p className="small muted">Проект Codex: {project.name}</p>}
                  <NativeInventory projectId={project?.id ?? ""} visible={visible} />
                  <DesktopControl
                    machines={machines}
                    open={visible}
                    threadId={threadId}
                    machineId={project?.machineId}
                  />
                </section>
                <section className="settings-service" aria-label="Подключение GPT">
                  <h4>
                    <Icon name="chat" />
                    GPT
                  </h4>
                  <GptConnectionSettings visible={visible} />
                  {pageWorkspace && <TeamGpt visible={visible} />}
                </section>
                <section className="settings-service" aria-label="Компьютеры и доступ">
                  <h4>
                    <Icon name="remote" />
                    Компьютеры
                  </h4>
                  <button type="button" className="secondary" onClick={onMachines}>
                    Компьютеры
                  </button>
                  {pageWorkspace && <TeamMachines visible={visible} />}
                </section>
              </>
            ),
            library: () => (
              <>
                {(["codex", "gpt"] as const).map((client) => (
                  <section
                    className="settings-service"
                    key={client}
                    aria-label={`История ${client === "codex" ? "Codex" : "GPT"}`}
                  >
                    <h4>{client === "codex" ? "Codex" : "GPT"}</h4>
                    <div className="settings-navigation-actions">
                      <button
                        type="button"
                        onClick={() => void refresh(client)}
                        disabled={!!refreshing}
                      >
                        <Icon name="refresh" />
                        {client === "codex" ? "Обновить проекты" : "Обновить чаты"}
                      </button>
                      <EntityArchive client={client} />
                    </div>
                    {client === "codex" && (
                      <button
                        type="button"
                        className="secondary"
                        onClick={onActivity}
                        disabled={!threadId}
                      >
                        <Icon name="activity" />
                        Активность диалога Codex
                      </button>
                    )}
                  </section>
                ))}
                {notice && <p role="status">{notice}</p>}
              </>
            ),
            maintenance: (visible) => (
              <>
                <DeploymentStatus open={visible} />
                <BridgeDoctorPanel open={visible} onTarget={onTarget} />
                <StorageUsage visible={visible} />
              </>
            ),
            access: () => (
              <>
                <AccountControls onSession={onSession} onLogout={onLogout} />
                <p className="small muted">
                  Для установки на iPhone: Поделиться → На экран «Домой».
                </p>
              </>
            ),
          }}
        />
      </UsageLimitsProvider>
    </dialog>
  );
}
