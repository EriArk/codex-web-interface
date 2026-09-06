import { type CSSProperties, useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api, configureApi, messageOf } from "./api";
import { Chat } from "./Chat";
import { Icon } from "./icons";
import { Login } from "./Login";
import { ProjectDialog } from "./ProjectDialog";
import { ProjectNavigation } from "./ProjectNavigation";
import { Remote } from "./Remote";
import { ActivityPane, Results } from "./Results";
import type {
  Activity,
  History,
  Machine,
  Project,
  Result,
  Session,
  Theme,
  Thread,
  TurnSettings,
  View,
} from "./types";
import { useWorkspace } from "./useWorkspace";

const readPreference = (name: string, fallback: string) => {
  try {
    return localStorage.getItem(`codex-${name}`) ?? fallback;
  } catch {
    return fallback;
  }
};
function useViewport() {
  useEffect(() => {
    const update = () => {
      const viewport = window.visualViewport;
      document.documentElement.style.setProperty(
        "--app-height",
        `${viewport?.height ?? window.innerHeight}px`,
      );
      document.documentElement.style.setProperty("--app-top", `${viewport?.offsetTop ?? 0}px`);
      document.documentElement.dataset.keyboard = String(
        window.innerHeight - (viewport?.height ?? window.innerHeight) > 150,
      );
    };
    update();
    window.visualViewport?.addEventListener("resize", update);
    window.visualViewport?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    return () => {
      window.visualViewport?.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, []);
}
export default function App() {
  const [session, setSession] = useState<Session | null>(null),
    [loading, setLoading] = useState(true),
    [requiresSetup, setRequiresSetup] = useState(false),
    [error, setError] = useState("");
  useViewport();
  const login = useCallback((value: Session) => {
    configureApi(value.csrf, () => setSession(null));
    setSession(value);
  }, []);
  useEffect(() => {
    void (async () => {
      try {
        const status = await api<{ requiresSetup: boolean }>("/auth/status");
        setRequiresSetup(status.requiresSetup);
        if (!status.requiresSetup) {
          try {
            login(await api<Session>("/auth/session"));
          } catch {
            /* The password form handles a missing session. */
          }
        }
      } catch (e) {
        setError(messageOf(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [login]);
  if (loading)
    return (
      <div className="boot-screen">
        <img src="/icon.svg" width="60" height="60" alt="Codex" />
        <span className="spinner" />
      </div>
    );
  if (error)
    return (
      <div className="boot-screen">
        <h1>Вернёмся к работе, когда появится связь.</h1>
        <p>{error}</p>
        <button type="button" className="primary" onClick={() => location.reload()}>
          <Icon name="refresh" />
          Попробовать снова
        </button>
      </div>
    );
  if (!session)
    return (
      <Login
        requiresSetup={requiresSetup}
        onLogin={(value) => {
          setRequiresSetup(false);
          login(value);
        }}
      />
    );
  return (
    <Workspace
      onLogout={() => {
        setSession(null);
        for (const key of Object.keys(sessionStorage))
          if (key.startsWith("codex-draft-")) sessionStorage.removeItem(key);
      }}
    />
  );
}
function Workspace({ onLogout }: { onLogout: () => void }) {
  const [initialized, setInitialized] = useState(false),
    [wide, setWide] = useState(window.innerWidth >= 1100);
  const [projects, setProjects] = useState<Project[]>([]),
    [threads, setThreads] = useState<Thread[]>([]);
  const [threadGroups, setThreadGroups] = useState<Record<string, Thread[]>>({});
  const [sending, setSending] = useState(false),
    [sendError, setSendError] = useState("");
  const [writeBlocked, setWriteBlocked] = useState(false);
  const sendingRef = useRef(false);
  const pendingSend = useRef<{ signature: string; key: string } | undefined>(undefined);
  const [machines, setMachines] = useState<Machine[]>([]),
    [createProject, setCreateProject] = useState(false),
    [syncing, setSyncing] = useState(false),
    [remoteImmersive, setRemoteImmersive] = useState(false);
  const threadRequest = useRef(0);
  const [projectId, setProjectId] = useState(""),
    [threadId, setThreadId] = useState(""),
    [view, setView] = useState<View>("chat"),
    [theme, setTheme] = useState<Theme>(readPreference("theme", "organizer") as Theme);
  const selectionRef = useRef({ projectId, threadId });
  selectionRef.current = { projectId, threadId };
  const [drawer, setDrawer] = useState(false),
    [settings, setSettings] = useState(false),
    [navCollapsed, setNavCollapsed] = useState(false),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState("");
  const [machine, setMachine] = useState<"checking" | "online" | "offline">("checking");
  const [results, setResults] = useState<Result[]>([]),
    [resultCursor, setResultCursor] = useState<number | null>(null),
    [activity, setActivity] = useState<Activity[]>([]),
    [activityCursor, setActivityCursor] = useState<number | null>(null);
  const [focusResult, setFocusResult] = useState(""),
    [focusTurn, setFocusTurn] = useState("");
  const [rightWidth, setRightWidth] = useState(Number(readPreference("right-width", "38")));
  const root = useRef<HTMLDivElement>(null),
    settingsDialog = useRef<HTMLDialogElement>(null),
    drawerDialog = useRef<HTMLDialogElement>(null);
  const { state, older, reconnect, refresh } = useWorkspace(threadId);
  const project = projects.find((p) => p.id === projectId);
  const selectedThread = threads.find((t) => t.id === threadId);
  const action = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    if (busy) return;
    setBusy(true);
    setNotice("");
    try {
      return await fn();
    } catch (e) {
      setNotice(messageOf(e));
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  const loadThreads = useCallback(async (id: string, selected?: string) => {
    const request = ++threadRequest.current;
    const data = await api<{ threads: Thread[]; warning?: string }>(`/projects/${id}/threads`);
    if (request !== threadRequest.current) return;
    setThreads(data.threads);
    setThreadGroups((groups) => ({ ...groups, [id]: data.threads }));
    if (data.warning) setNotice(data.warning);
    setThreadId((current) =>
      selected && data.threads.some((t) => t.id === selected)
        ? selected
        : data.threads.some((t) => t.id === current)
          ? current
          : (data.threads[0]?.id ?? ""),
    );
  }, []);
  useEffect(() => {
    void (async () => {
      try {
        const [{ projects: list }, prefs, machineList] = await Promise.all([
          api<{ projects: Project[] }>("/projects"),
          api<{ projectId?: string; threadId?: string; theme?: Theme; view?: View }>(
            "/preferences",
          ),
          api<{ machines: Machine[] }>("/machines"),
        ]);
        setMachines(machineList.machines);
        setProjects(list);
        if (prefs.theme) setTheme(prefs.theme);
        if (prefs.view) setView(prefs.view);
        const id = list.some((p) => p.id === prefs.projectId)
          ? (prefs.projectId ?? "")
          : (list[0]?.id ?? "");
        setProjectId(id);
        if (id) await loadThreads(id, prefs.threadId);
        setInitialized(true);
      } catch (e) {
        setNotice(messageOf(e));
      }
    })();
  }, [loadThreads]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("codex-theme", theme);
    } catch {
      /* Optional preference cache. */
    }
    if (initialized) void api("/preferences", { method: "PATCH", body: { theme } }).catch(() => {});
  }, [theme, initialized]);
  useEffect(() => {
    const query = matchMedia("(min-width:1100px)");
    const change = () => setWide(query.matches);
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);
  useEffect(() => {
    if (!projectId) return;
    let disposed = false;
    setMachine("checking");
    void api<{ available: boolean }>(`/projects/${projectId}/status`)
      .then((s) => {
        if (!disposed) setMachine(s.available ? "online" : "offline");
      })
      .catch(() => {
        if (!disposed) setMachine("offline");
      });
    return () => {
      disposed = true;
    };
  }, [projectId]);
  useEffect(() => {
    if (!projectId) return;
    void api("/preferences", {
      method: "PATCH",
      body: { projectId, ...(threadId ? { threadId } : {}), view },
    }).catch(() => {});
  }, [projectId, threadId, view]);
  const loadResults = useCallback(async () => {
    if (!threadId) {
      setResults([]);
      setResultCursor(null);
      return;
    }
    const data = await api<{ items: Result[]; nextBefore: number | null }>(
      `/threads/${threadId}/results`,
    );
    setResults(data.items);
    setResultCursor(data.nextBefore);
  }, [threadId]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Result events invalidate the current page.
  useEffect(() => {
    void loadResults().catch((e) => setNotice(messageOf(e)));
  }, [loadResults, state.revision]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Activity refreshes after a turn or result event.
  useEffect(() => {
    if (view !== "activity" || !threadId) return;
    let disposed = false;
    void api<{ items: Activity[]; nextBefore: number | null }>(`/threads/${threadId}/activity`)
      .then((data) => {
        if (!disposed) {
          setActivity(data.items);
          setActivityCursor(data.nextBefore);
        }
      })
      .catch((e) => {
        if (!disposed) setNotice(messageOf(e));
      });
    return () => {
      disposed = true;
    };
  }, [view, threadId, state.revision]);
  useEffect(() => {
    if (settings) settingsDialog.current?.showModal();
    else settingsDialog.current?.close();
  }, [settings]);
  useEffect(() => {
    if (drawer) drawerDialog.current?.showModal();
    else drawerDialog.current?.close();
  }, [drawer]);
  const selectThread = (id: string, owner = projectId) => {
    if (owner !== projectId) {
      setProjectId(owner);
      setThreads(threadGroups[owner] ?? []);
      void loadThreads(owner, id).catch((e) => setNotice(messageOf(e)));
    }
    setThreadId(id);
    setView("chat");
    setFocusTurn("");
    setDrawer(false);
  };
  const newThread = (owner = projectId) =>
    void action(async () => {
      const thread = await api<Thread>(`/projects/${owner}/threads`, {
        method: "POST",
        key: crypto.randomUUID(),
        body: { title: "Новый диалог" },
      });
      setProjectId(owner);
      setThreadId(thread.id);
      setThreads((list) => [thread, ...list.filter((item) => item.projectId === owner)]);
      setThreadGroups((groups) => ({ ...groups, [owner]: [thread, ...(groups[owner] ?? [])] }));
      void loadThreads(owner, thread.id).catch(() => {});
      setView("chat");
      setDrawer(false);
    });
  const send = async (
    text: string,
    settings: TurnSettings,
    attachments: string[],
  ): Promise<boolean> => {
    if (busy || sendingRef.current) return false;
    sendingRef.current = true;
    setBusy(true);
    setSending(true);
    setSendError("");
    setWriteBlocked(false);
    setNotice("");
    const signature = JSON.stringify({ threadId, text, settings, attachments });
    if (pendingSend.current?.signature !== signature)
      pendingSend.current = { signature, key: crypto.randomUUID() };
    try {
      await api(`/threads/${threadId}/turns`, {
        method: "POST",
        key: pendingSend.current.key,
        body: { text, settings, attachments },
      });
      pendingSend.current = undefined;
      // Metadata refresh cannot turn an acknowledged send into a failed send.
      void loadThreads(projectId, threadId).catch(() => {});
      return true;
    } catch (error) {
      if (
        error instanceof ApiError &&
        ["THREAD_IN_USE", "PROJECT_BUSY", "INVALID_REQUEST"].includes(error.code)
      )
        pendingSend.current = undefined;
      setWriteBlocked(error instanceof ApiError && error.code === "THREAD_IN_USE");
      setSendError(messageOf(error));
      return false;
    } finally {
      sendingRef.current = false;
      setSending(false);
      setBusy(false);
    }
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: A different chat needs a fresh composer error.
  useEffect(() => {
    setSendError("");
    setWriteBlocked(false);
  }, [threadId]);
  useEffect(() => {
    if (!state.thread.id) return;
    const update = (list: Thread[]) =>
      list.map((t) =>
        t.id === state.thread.id
          ? { ...t, status: state.thread.status, activeTurnId: state.thread.activeTurnId }
          : t,
      );
    setThreads(update);
    setThreadGroups((groups) => ({
      ...groups,
      [state.thread.projectId]: update(groups[state.thread.projectId] ?? []),
    }));
  }, [state.thread.id, state.thread.projectId, state.thread.status, state.thread.activeTurnId]);
  const expandProject = useCallback(async (id: string) => {
    const data = await api<{ threads: Thread[]; warning?: string }>(`/projects/${id}/threads`);
    setThreadGroups((groups) => ({ ...groups, [id]: data.threads }));
    if (data.warning) setNotice(data.warning);
  }, []);
  const resume = async () => {
    if (busy) return;
    setBusy(true);
    setNotice("");
    const selected = threadId;
    try {
      await api(`/threads/${selected}/resume`, { method: "POST" });
      if (selectionRef.current.threadId !== selected) return;
      setSendError("");
      setWriteBlocked(false);
      setNotice("Диалог готов к работе через сайт. Можно отправлять сообщение.");
      // Recover access only: the owner decides when to send the preserved draft.
      void refresh().catch(() => {});
      reconnect();
    } catch (error) {
      if (selectionRef.current.threadId !== selected) return;
      setWriteBlocked(error instanceof ApiError && error.code === "THREAD_IN_USE");
      setSendError(messageOf(error));
    } finally {
      setBusy(false);
    }
  };
  const showResult = (id: string) => {
    setFocusResult(id);
    setView("results");
  };
  const showTurn = async (id: string) => {
    if (!state.messages.some((m) => m.turnId === id)) {
      setNotice("Это сообщение выше в истории. Подгружаем нужный фрагмент…");
      // A bounded context request avoids downloading the whole conversation.
      const context = await api<History>(
        `/threads/${threadId}/history?turnId=${encodeURIComponent(id)}`,
      );
      window.dispatchEvent(
        new CustomEvent("codex-focus-history", { detail: { threadId, history: context } }),
      );
      setNotice("");
    }
    setFocusTurn("");
    setView("chat");
    requestAnimationFrame(() => setFocusTurn(id));
  };
  const refreshCatalog = useCallback(
    async (force = false) => {
      setSyncing(true);
      try {
        const data = await api<{ projects: Project[]; warnings?: string[] }>(
          force ? "/projects?refresh=1" : "/projects",
        );
        setProjects(data.projects);
        if (data.warnings?.length) setNotice(data.warnings[0] ?? "");
        const selected = selectionRef.current;
        if (selected.projectId && data.projects.some((p) => p.id === selected.projectId))
          await loadThreads(selected.projectId, selected.threadId);
      } catch (e) {
        setNotice(messageOf(e));
      } finally {
        setSyncing(false);
      }
    },
    [loadThreads],
  );
  useEffect(() => {
    if (!initialized) return;
    const update = () => {
      if (document.visibilityState === "visible") void refreshCatalog();
    };
    const timer = setInterval(update, 60000);
    document.addEventListener("visibilitychange", update);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", update);
    };
  }, [initialized, refreshCatalog]);
  const navigation = (
    <ProjectNavigation
      projects={projects}
      threadGroups={threadGroups}
      projectId={projectId}
      threadId={threadId}
      busy={busy}
      loading={!initialized || syncing}
      machine={machine}
      onExpand={expandProject}
      onThread={selectThread}
      onNewThread={newThread}
      onNewProject={() => {
        setDrawer(false);
        setCreateProject(true);
      }}
      onRefresh={() => void refreshCatalog(true)}
      onClose={() => setDrawer(false)}
      onSettings={() => {
        setDrawer(false);
        setSettings(true);
      }}
    />
  );
  const tab = (name: View, label: string, icon: string) => (
    <button
      type="button"
      className={view === name ? "active" : ""}
      onClick={() => setView(name)}
      aria-current={view === name ? "page" : undefined}
    >
      <Icon name={icon} />
      <span>{label}</span>
      {name === "results" && results.length > 0 && (
        <span className="tab-count">{results.length}</span>
      )}
    </button>
  );
  return (
    <div
      className={`workspace ${navCollapsed ? "nav-collapsed" : ""}`}
      data-view={view}
      data-remote-immersive={remoteImmersive}
      ref={root}
      style={{ "--right-width": `${rightWidth}%` } as CSSProperties}
    >
      <aside className="desktop-nav">{navigation}</aside>
      <header className="workspace-header">
        <button
          type="button"
          className="icon-button menu-button"
          aria-label="Открыть проекты"
          onClick={() => {
            if (window.innerWidth >= 1100) setNavCollapsed((v) => !v);
            else setDrawer(true);
          }}
        >
          <Icon name="menu" />
        </button>
        <div className="header-project">
          <span>
            <Icon name="folder" size={17} />
            {project?.name ?? "Рабочее пространство"}
          </span>
          <small>{selectedThread?.title ?? "Выбери диалог"}</small>
        </div>
        <div className="header-connection">
          <span
            className={
              sending || ["running", "starting"].includes(state.thread.status)
                ? "spinner"
                : `status-dot ${state.thread.status === "waiting_approval" ? "attention" : state.connection === "connected" ? "online" : ""}`
            }
            role="img"
            aria-label={
              state.thread.status === "waiting_approval"
                ? "Codex ждёт ответа"
                : sending || ["running", "starting"].includes(state.thread.status)
                  ? "Codex работает"
                  : "Соединение"
            }
          />
          <span>
            {threadId
              ? state.connection === "connected"
                ? "На связи"
                : "Подключение…"
              : "Личный Hub"}
          </span>
        </div>
        <button
          type="button"
          className="icon-button"
          onClick={() => newThread()}
          disabled={busy || !projectId}
          aria-label="Создать диалог"
        >
          <Icon name="plus" />
        </button>
        <button
          type="button"
          className="icon-button"
          onClick={() => setSettings(true)}
          aria-label="Настройки"
        >
          <Icon name="settings" />
        </button>
      </header>
      {notice && (
        <div className="global-notice" role="status">
          <span>{notice}</span>
          <button
            type="button"
            className="icon-button"
            onClick={() => setNotice("")}
            aria-label="Закрыть уведомление"
          >
            <Icon name="close" size={17} />
          </button>
        </div>
      )}
      <main className="workspace-content">
        <Chat
          projectId={projectId}
          threadId={threadId}
          state={state}
          sending={sending}
          sendError={sendError}
          writeBlocked={writeBlocked}
          visible={wide || view === "chat"}
          busy={busy}
          results={results}
          focusTurn={focusTurn}
          onSend={send}
          onStop={() =>
            void action(() => api(`/threads/${threadId}/interrupt`, { method: "POST" }))
          }
          onOlder={older}
          onCreate={() => newThread()}
          onDecision={(id, decision) =>
            void action(() =>
              api(`/approvals/${id}`, {
                method: "POST",
                key: crypto.randomUUID(),
                body: { decision },
              }),
            )
          }
          onAnswer={(id, answers) =>
            void action(() =>
              api(`/approvals/${id}/answers`, {
                method: "POST",
                key: crypto.randomUUID(),
                body: { answers },
              }),
            )
          }
          onResult={showResult}
          onReconnect={() => void resume()}
          onLatest={() => void refresh().catch((e) => setNotice(messageOf(e)))}
        />
        <hr
          className="pane-divider"
          aria-label="Ширина результатов"
          aria-orientation="vertical"
          aria-valuenow={rightWidth}
          aria-valuemin={28}
          aria-valuemax={55}
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft") setRightWidth((v) => Math.min(55, v + 2));
            if (e.key === "ArrowRight") setRightWidth((v) => Math.max(28, v - 2));
          }}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            if (e.currentTarget.hasPointerCapture(e.pointerId)) {
              const rect = root.current?.getBoundingClientRect();
              if (rect) {
                const value = Math.max(
                  28,
                  Math.min(55, (100 * (rect.right - e.clientX)) / rect.width),
                );
                setRightWidth(value);
                try {
                  localStorage.setItem("codex-right-width", String(value));
                } catch {
                  /* Optional preference. */
                }
              }
            }
          }}
          onPointerUp={(e) => e.currentTarget.releasePointerCapture(e.pointerId)}
        />
        <div className="support-pane">
          <div className="support-tabs">
            {tab("results", "Результаты", "results")}
            {tab("activity", "Активность", "activity")}
            {tab("remote", "Remote", "remote")}
          </div>
          <Results
            results={results}
            visible={view === "results" || view === "chat"}
            focusId={focusResult}
            busy={busy}
            hasMore={!!resultCursor}
            onOlder={() =>
              void action(async () => {
                const data = await api<{ items: Result[]; nextBefore: number | null }>(
                  `/threads/${threadId}/results?before=${resultCursor}`,
                );
                setResults((old) => [...old, ...data.items]);
                setResultCursor(data.nextBefore);
              })
            }
            onTurn={(id) => void showTurn(id).catch((e) => setNotice(messageOf(e)))}
          />
          <ActivityPane
            items={activity}
            visible={view === "activity"}
            hasMore={!!activityCursor}
            onOlder={() =>
              void action(async () => {
                const data = await api<{ items: Activity[]; nextBefore: number | null }>(
                  `/threads/${threadId}/activity?before=${activityCursor}`,
                );
                setActivity((old) => [...old, ...data.items]);
                setActivityCursor(data.nextBefore);
              })
            }
          />
          <Remote
            projectId={projectId}
            threadId={threadId}
            visible={view === "remote"}
            available={!!project?.remoteAvailable}
            onImmersiveChange={setRemoteImmersive}
            onBack={() => setView("chat")}
            onSnapshot={() => {
              setNotice("Снимок сохранён в результатах");
              void loadResults();
            }}
          />
        </div>
      </main>
      <nav className="mobile-tabs" aria-label="Разделы рабочего пространства">
        {tab("chat", "Чат", "chat")}
        {tab("results", "Результаты", "results")}
        {tab("remote", "Remote", "remote")}
      </nav>
      <ProjectDialog
        open={createProject}
        machines={machines}
        onClose={() => setCreateProject(false)}
        onCreated={async (p) => {
          const data = await api<{ projects: Project[] }>("/projects?refresh=1");
          setProjects(data.projects);
          setProjectId(p.id);
          setThreads([]);
          setThreadId("");
          setView("chat");
          await loadThreads(p.id);
        }}
      />
      <dialog className="project-sheet" ref={drawerDialog} onCancel={() => setDrawer(false)}>
        <div className="sheet-content">{navigation}</div>
      </dialog>
      <dialog className="settings-dialog" ref={settingsDialog} onCancel={() => setSettings(false)}>
        <div className="dialog-heading">
          <h2>Настройки</h2>
          <button
            type="button"
            className="icon-button"
            onClick={() => setSettings(false)}
            aria-label="Закрыть настройки"
          >
            <Icon name="close" />
          </button>
        </div>
        <p className="muted">Твоё пространство, твой стиль.</p>
        <fieldset className="theme-picker">
          <legend>Оформление</legend>
          {(
            [
              ["organizer", "Органайзер", "Бумага, закладки, спокойный зелёный"],
              ["crt-green", "Зелёный терминал", "Чёткий текст и свет фосфора"],
              ["hitech-2000s", "Hi-Tech 2000s", "Холодный металл и синий свет"],
            ] as const
          ).map(([id, title, description]) => (
            <label key={id} className={`theme-option ${id}`}>
              <input
                type="radio"
                name="theme"
                checked={theme === id}
                onChange={() => setTheme(id)}
              />
              <span className="theme-swatch" />
              <span>
                {title}
                <small>{description}</small>
              </span>
            </label>
          ))}
        </fieldset>
        <button
          type="button"
          className="secondary settings-activity"
          onClick={() => {
            setView("activity");
            setSettings(false);
          }}
        >
          <Icon name="activity" />
          Активность диалога
        </button>
        <button
          type="button"
          className="text-button logout"
          onClick={() =>
            void action(async () => {
              await api("/auth/logout", { method: "POST" });
              onLogout();
            })
          }
        >
          <Icon name="logout" />
          Выйти
        </button>
        <p className="small muted">Для установки на iPhone: Поделиться → На экран «Домой».</p>
      </dialog>
    </div>
  );
}
