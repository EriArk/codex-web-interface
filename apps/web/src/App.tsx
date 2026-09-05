import { type CSSProperties, useCallback, useEffect, useRef, useState } from "react";
import { api, configureApi, messageOf } from "./api";
import { Chat } from "./Chat";
import { Icon } from "./icons";
import { Login } from "./Login";
import { Remote } from "./Remote";
import { ActivityPane, Results } from "./Results";
import type {
  Activity,
  History,
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
  const [projectId, setProjectId] = useState(""),
    [threadId, setThreadId] = useState(""),
    [view, setView] = useState<View>("chat"),
    [theme, setTheme] = useState<Theme>(readPreference("theme", "organizer") as Theme);
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
    const data = await api<{ threads: Thread[] }>(`/projects/${id}/threads`);
    setThreads(data.threads);
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
        const [{ projects: list }, prefs] = await Promise.all([
          api<{ projects: Project[] }>("/projects"),
          api<{ projectId?: string; threadId?: string; theme?: Theme; view?: View }>(
            "/preferences",
          ),
        ]);
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
  const selectProject = (id: string) => {
    setProjectId(id);
    setThreadId("");
    setFocusTurn("");
    void loadThreads(id).catch((e) => setNotice(messageOf(e)));
  };
  const selectThread = (id: string) => {
    setThreadId(id);
    setView("chat");
    setFocusTurn("");
    setDrawer(false);
  };
  const newThread = () =>
    void action(async () => {
      const thread = await api<Thread>(`/projects/${projectId}/threads`, {
        method: "POST",
        key: crypto.randomUUID(),
        body: { title: "Новый диалог" },
      });
      await loadThreads(projectId, thread.id);
      setView("chat");
      setDrawer(false);
    });
  const send = async (
    text: string,
    settings: TurnSettings,
    attachments: string[],
  ): Promise<boolean> => {
    const response = await action(async () => {
      await api(`/threads/${threadId}/turns`, {
        method: "POST",
        key: crypto.randomUUID(),
        body: { text, settings, attachments },
      });
      await loadThreads(projectId, threadId);
      return true;
    });
    return response === true;
  };
  const resume = () =>
    void action(async () => {
      await api(`/threads/${threadId}/resume`, { method: "POST" });
      await refresh();
      reconnect();
    });
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
  const navigation = (
    <>
      <div className="nav-brand">
        <img src="/icon.svg" width="32" height="32" alt="" />
        <span>
          codex<span className="small brand-subtitle">личное пространство</span>
        </span>
        <button
          type="button"
          className="icon-button mobile-only"
          aria-label="Закрыть проекты"
          onClick={() => setDrawer(false)}
        >
          <Icon name="close" />
        </button>
      </div>
      <div className="nav-scroll">
        <div className="nav-label">
          Проекты<span>{projects.length}</span>
        </div>
        {projects.map((p) => (
          <button
            type="button"
            key={p.id}
            className={`nav-project ${projectId === p.id ? "selected" : ""}`}
            disabled={busy}
            onClick={() => selectProject(p.id)}
          >
            <span className="folder-icon">
              <Icon name="folder" />
            </span>
            <span>
              {p.name}
              <small>{p.machineName}</small>
            </span>
          </button>
        ))}
        <div className="nav-label threads-label">
          Диалоги
          <button
            type="button"
            className="icon-button"
            onClick={newThread}
            disabled={busy || !projectId}
            aria-label="Новый диалог"
          >
            <Icon name="plus" size={18} />
          </button>
        </div>
        {!threads.length && (
          <p className="nav-empty">
            Первый диалог начнётся
            <br />с твоей задачи.
          </p>
        )}
        {threads.map((t) => (
          <button
            type="button"
            className={`nav-thread ${threadId === t.id ? "selected" : ""}`}
            key={t.id}
            disabled={busy}
            onClick={() => selectThread(t.id)}
          >
            <Icon name="chat" size={17} />
            <span>{t.title}</span>
          </button>
        ))}
      </div>
      <div className="nav-bottom">
        <div className="machine-indicator">
          <span className={`status-dot ${machine}`} />
          <span>
            {project?.machineName ?? "Компьютер"}
            <small>
              {machine === "online"
                ? "На связи"
                : machine === "offline"
                  ? "Нет соединения"
                  : "Проверяем соединение"}
            </small>
          </span>
        </div>
        <button
          type="button"
          className="nav-settings"
          onClick={() => {
            setDrawer(false);
            setSettings(true);
          }}
        >
          <Icon name="settings" size={18} />
          Настройки
        </button>
      </div>
    </>
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
          <span className={`status-dot ${state.connection === "connected" ? "online" : ""}`} />
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
          onClick={newThread}
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
          visible={wide || view === "chat"}
          busy={busy}
          results={results}
          focusTurn={focusTurn}
          onSend={send}
          onStop={() =>
            void action(() => api(`/threads/${threadId}/interrupt`, { method: "POST" }))
          }
          onOlder={older}
          onCreate={newThread}
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
          onReconnect={resume}
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
