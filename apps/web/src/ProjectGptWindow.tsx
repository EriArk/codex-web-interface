import type {
  ActivityGptHandoff,
  GptConversation,
  NotebookLink,
  ProjectGpt,
} from "@codex-web/shared";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { AgentProfileButton } from "./AgentProfileEditor";
import { accountSessionStorage as storage } from "./accountStorage";
import { api, messageOf } from "./api";
import { IssueDrawerButton } from "./IssueDrawer";
import { Icon } from "./icons";
import { useWorkspaceDialog } from "./useWorkspaceDialog";
import "./project-gpt.css";

const Preparation = lazy(() =>
  import("./ProjectPreparation").then((m) => ({ default: m.ProjectPreparation })),
);
const Workspace = lazy(() => import("./GptWorkspace").then((m) => ({ default: m.GptWorkspace })));
export function ProjectGptWindow({
  projectId,
  name,
  onClose,
  onSettings,
  onRemote,
  initialHandoff,
  onPrepared,
}: {
  projectId: string;
  name: string;
  onClose: () => void;
  onSettings: () => void;
  onRemote: () => void;
  initialHandoff?: ActivityGptHandoff;
  onPrepared: (target: NotebookLink) => void;
}) {
  const handoffKey = `project-activity-handoff:${projectId}`;
  const [handoff, setHandoff] = useState<ActivityGptHandoff | null>(() => {
    if (initialHandoff) return initialHandoff;
    try {
      const v = JSON.parse(storage.getItem(handoffKey) ?? "null");
      return v?.projectId === projectId && typeof v.id === "string" ? v : null;
    } catch {
      return null;
    }
  });
  useEffect(() => {
    if (handoff) storage.setItem(handoffKey, JSON.stringify(handoff));
    else storage.removeItem(handoffKey);
  }, [handoff, handoffKey]);
  const dialog = useRef<HTMLDialogElement>(null);
  useWorkspaceDialog(dialog);
  const [data, setData] = useState<ProjectGpt | null>(null),
    [error, setError] = useState("");
  const [preparing, setPreparing] = useState(false);
  const [configure, setConfigure] = useState(false),
    [busy, setBusy] = useState(false);
  const [chats, setChats] = useState<GptConversation[]>([]),
    [next, setNext] = useState<number | null>(0);
  const [choice, setChoice] = useState("");
  const live = useRef(true),
    lock = useRef(false);
  const path = `/projects/${encodeURIComponent(projectId)}/gpt`;
  useEffect(() => {
    live.current = true;
    void api<ProjectGpt>(path)
      .then((d) => {
        if (live.current) {
          setData(d);
          setChoice(d.nativeId ?? "");
        }
      })
      .catch((e) => {
        if (live.current) setError(messageOf(e));
      });
    return () => {
      live.current = false;
    };
  }, [path]);
  const act = async (work: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (e) {
      if (live.current) setError(messageOf(e));
    } finally {
      lock.current = false;
      if (live.current) setBusy(false);
    }
  };
  const loadChats = async () => {
    if (next === null) return;
    const page = await api<{ items: GptConversation[]; nextOffset: number | null }>(
      `/gpt/conversations?offset=${next}`,
    );
    if (live.current) {
      setChats((old) => [...new Map([...old, ...page.items].map((c) => [c.id, c])).values()]);
      setNext(page.nextOffset);
    }
  };
  return (
    <dialog
      ref={dialog}
      tabIndex={-1}
      className="project-gpt-window"
      aria-label={`GPT проекта ${name}`}
      onCancel={onClose}
    >
      <header className="project-gpt-heading">
        <div>
          <strong>GPT проекта</strong>
          <small>{name}</small>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="Подготовить для Codex"
          onClick={() => setPreparing(true)}
        >
          <Icon name="file" />
        </button>
        <IssueDrawerButton targetId={projectId} />
        <button
          type="button"
          className="icon-button"
          aria-label="Настройки GPT проекта"
          aria-pressed={configure}
          onClick={() => {
            setConfigure((v) => !v);
            if (!configure)
              void act(async () => {
                const value = await api<ProjectGpt>(path);
                if (live.current) {
                  setData(value);
                  setChoice(value.nativeId ?? "");
                }
                if (!chats.length) await loadChats();
              });
          }}
        >
          <Icon name="settings" />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Закрыть GPT проекта"
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </header>
      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
      {!data && !error && <p role="status">Загружаю…</p>}
      {data && (
        <>
          <div className="project-gpt-config" hidden={!configure}>
            <p>Личный чат для этого проекта. Другие участники его не видят.</p>
            <label>
              Чат GPT
              <select
                aria-label="Чат GPT проекта"
                value={choice}
                onChange={(e) => setChoice(e.target.value)}
              >
                <option value="">Новый чат</option>
                {data.nativeId && !chats.some((c) => c.id === data.nativeId) && (
                  <option value={data.nativeId}>Текущий чат проекта</option>
                )}
                {chats
                  .filter((c) => !c.deleted && !c.archived)
                  .map((c) => (
                    <option value={c.id} key={c.id}>
                      {c.title}
                    </option>
                  ))}
              </select>
            </label>
            <div className="project-gpt-actions">
              {next !== null && (
                <button type="button" disabled={busy} onClick={() => void act(loadChats)}>
                  Ещё чаты
                </button>
              )}
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    const d = await api<ProjectGpt>(path, {
                      method: "PUT",
                      body: { nativeId: choice || null, revision: data.revision },
                    });
                    if (live.current) {
                      setData(d);
                      setConfigure(false);
                    }
                  })
                }
              >
                Выбрать чат
              </button>
            </div>
            <details>
              <summary>Контекст проекта</summary>
              <pre>{data.context}</pre>
            </details>
            <AgentProfileButton projectId={projectId} name={name} />
          </div>
          <div className="project-gpt-body" hidden={configure}>
            <Suspense fallback={<p role="status">Загружаю GPT…</p>}>
              <Workspace
                activityHandoff={handoff ?? undefined}
                onActivityClear={() => {
                  if (JSON.parse(storage.getItem(handoffKey) ?? "null")?.id === handoff?.id)
                    storage.removeItem(handoffKey);
                  setHandoff(null);
                }}
                key={data.revision}
                projectChat={data}
                onProjectChatChange={(value) => {
                  setData(value);
                  setChoice(value.nativeId ?? "");
                }}
                settings={false}
                overlayOpen={configure || preparing}
                onCodex={onClose}
                onNotificationHandled={() => {}}
                onSettings={() => {
                  onClose();
                  onSettings();
                }}
                onRemote={() => {
                  onClose();
                  onRemote();
                }}
              />
            </Suspense>
          </div>
        </>
      )}
      {preparing && (
        <Suspense fallback={null}>
          <Preparation
            projectId={projectId}
            name={name}
            onClose={() => setPreparing(false)}
            onOpen={onPrepared}
          />
        </Suspense>
      )}
    </dialog>
  );
}
