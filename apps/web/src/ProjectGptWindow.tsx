import {
  type GptConversation,
  type ProjectGpt,
  type ProjectRules,
  projectRuleLabels,
} from "@codex-web/shared";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { api, messageOf } from "./api";
import { Icon } from "./icons";
import { useWorkspaceDialog } from "./useWorkspaceDialog";
import "./project-gpt.css";

const Workspace = lazy(() => import("./GptWorkspace").then((m) => ({ default: m.GptWorkspace })));
export function ProjectGptWindow({
  projectId,
  name,
  onClose,
  onSettings,
  onRemote,
}: {
  projectId: string;
  name: string;
  onClose: () => void;
  onSettings: () => void;
  onRemote: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useWorkspaceDialog(dialog);
  const [data, setData] = useState<ProjectGpt | null>(null),
    [error, setError] = useState("");
  const [configure, setConfigure] = useState(false),
    [busy, setBusy] = useState(false);
  const [rules, setRules] = useState<ProjectRules>({ enabled: [], custom: "" });
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
          setRules(d.rules);
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
            <details>
              <summary>Дополнительные правила</summary>
              <p>
                Для следующих запросов Codex и GPT. Создадим локальный CODEXWEB.md вне коммитов;
                AGENTS.md останется вашим.
              </p>
              {Object.entries(projectRuleLabels).map(([id, title]) => {
                const key = id as keyof typeof projectRuleLabels;
                return (
                  <label className="project-rule" key={key}>
                    <input
                      type="checkbox"
                      checked={rules.enabled.includes(key)}
                      onChange={(e) =>
                        setRules((r) => ({
                          ...r,
                          enabled: e.target.checked
                            ? [...r.enabled, key]
                            : r.enabled.filter((v) => v !== key),
                        }))
                      }
                    />
                    {title}
                  </label>
                );
              })}
              <label>
                Свои пожелания
                <textarea
                  aria-label="Свои правила проекта"
                  rows={4}
                  maxLength={4000}
                  value={rules.custom}
                  onChange={(e) => setRules((r) => ({ ...r, custom: e.target.value }))}
                />
              </label>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    const d = await api<ProjectGpt>(`${path}/rules`, {
                      method: "PUT",
                      body: rules,
                    });
                    if (live.current) {
                      setData(d);
                      setConfigure(false);
                    }
                  })
                }
              >
                Применить правила
              </button>
            </details>
          </div>
          <div className="project-gpt-body" hidden={configure}>
            <Suspense fallback={<p role="status">Загружаю GPT…</p>}>
              <Workspace
                key={data.revision}
                projectChat={data}
                onProjectChatChange={(value) => {
                  setData(value);
                  setChoice(value.nativeId ?? "");
                }}
                settings={false}
                overlayOpen={configure}
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
    </dialog>
  );
}
