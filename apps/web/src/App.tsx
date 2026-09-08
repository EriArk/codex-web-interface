import type { NotebookLink, ResultCategory } from "@codex-web/shared";
import {
  type CSSProperties,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { AccountControls } from "./AccountControls";
import { ApiError, api, configureApi, messageOf } from "./api";
import { Chat } from "./Chat";
import type { RecoveryOutcome } from "./ConnectionRecovery";
import { DesktopControl } from "./DesktopControl";
import { type LibraryChange, libraryEvent } from "./EntityMenu";
import { GptLoadBoundary } from "./GptLoadBoundary";
import { Icon } from "./icons";
import { Login } from "./Login";
import { MachineHealthPanel } from "./MachineHealth";
import { NotebookPanel, type NotebookRequest, type WorkspaceDestination } from "./Notebook";
import { Notifications, type NotificationTarget, useNotificationPresence } from "./Notifications";
import { ProjectDialog } from "./ProjectDialog";
import { ProjectFiles } from "./ProjectFiles";
import { ProjectNavigation } from "./ProjectNavigation";
import { ProjectOverview } from "./ProjectOverview";
import { completePendingSend, pendingSendKey } from "./pendingSend";
import { Remote } from "./Remote";
import { ResultFeed } from "./ResultFeed";
import { ActivityPane } from "./Results";
import { StorageUsage } from "./StorageUsage";
import { applyTheme, cachedTheme, themes } from "./theme";
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
import { UsageLimits } from "./UsageLimits";
import { useNavigation } from "./useNavigation";
import { useProjectDrawer } from "./useProjectDrawer";
import { useProjectSwipe } from "./useProjectSwipe";
import { useWorkspace } from "./useWorkspace";

const GptWorkspace = lazy(() =>
  import("./GptWorkspace").then((module) => ({ default: module.GptWorkspace })),
);

const readPreference = (name: string, fallback: string) => {
  try {
    return localStorage.getItem(`codex-${name}`) ?? fallback;
  } catch {
    return fallback;
  }
};
function useViewport() {
  useEffect(() => {
    let width = window.innerWidth;
    let tallest = window.visualViewport?.height ?? window.innerHeight;
    let keyboard = false;
    let frame = 0;
    const update = () => {
      const viewport = window.visualViewport;
      const height = Math.min(viewport?.height ?? window.innerHeight, window.innerHeight);
      if (Math.abs(window.innerWidth - width) > 80) {
        width = window.innerWidth;
        tallest = Math.max(height, window.innerHeight);
      } else tallest = Math.max(tallest, height);
      const editing = document.activeElement?.matches(
        "textarea, input:not([type=checkbox]):not([type=radio]), [contenteditable=true]",
      );
      // Some iOS versions shrink innerHeight together with visualViewport.
      keyboard =
        window.innerHeight - height > 150 || (tallest - height > 150 && (!!editing || keyboard));
      document.documentElement.style.setProperty("--app-height", `${height}px`);
      document.documentElement.style.setProperty("--app-top", `${viewport?.offsetTop ?? 0}px`);
      document.documentElement.dataset.keyboard = String(keyboard);
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(document.documentElement);
    update();
    window.visualViewport?.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("scroll", schedule);
    window.addEventListener("resize", schedule);
    document.addEventListener("focusin", schedule);
    document.addEventListener("focusout", schedule);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      window.visualViewport?.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      document.removeEventListener("focusin", schedule);
      document.removeEventListener("focusout", schedule);
    };
  }, []);
}
export default function App() {
  const [session, setSession] = useState<Session | null>(null),
    [loading, setLoading] = useState(true),
    [requiresSetup, setRequiresSetup] = useState(false),
    [recovering, setRecovering] = useState(() =>
      new URLSearchParams(location.hash.slice(1)).has("recover"),
    ),
    [error, setError] = useState("");
  useViewport();
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.data?.type !== "notification.open" || !/^[a-f0-9]{32}$/.test(String(event.data.id)))
        return;
      history.replaceState(
        history.state,
        "",
        location.pathname + location.search + "#notification=" + event.data.id,
      );
      window.dispatchEvent(new Event("hashchange"));
    };
    navigator.serviceWorker?.addEventListener("message", receive);
    return () => navigator.serviceWorker?.removeEventListener("message", receive);
  }, []);
  useEffect(() => {
    const update = () => setRecovering(new URLSearchParams(location.hash.slice(1)).has("recover"));
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  const login = useCallback((value: Session) => {
    configureApi(value.csrf, () => setSession(null));
    setSession(value);
  }, []);
  useEffect(() => {
    void (async () => {
      try {
        const status = await api<{ requiresSetup: boolean }>("/auth/status");
        setRequiresSetup(status.requiresSetup);
        if (!status.requiresSetup && !new URLSearchParams(location.hash.slice(1)).has("recover")) {
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
  if (!session || recovering)
    return (
      <Login
        requiresSetup={requiresSetup}
        onLogin={(value) => {
          setRequiresSetup(false);
          setRecovering(false);
          login(value);
        }}
      />
    );
  return (
    <Workspace
      onSession={login}
      onLogout={() => {
        setSession(null);
        for (const key of Object.keys(sessionStorage))
          if (
            key.startsWith("codex-draft-") ||
            key.startsWith("gpt-draft-") ||
            key.startsWith("codex-pending-send:")
          )
            sessionStorage.removeItem(key);
      }}
    />
  );
}
function clearNotification(id: string) {
  if (new URLSearchParams(location.hash.slice(1)).get("notification") === id)
    history.replaceState(history.state, "", location.pathname + location.search);
}

function Workspace({
  onLogout,
  onSession,
}: {
  onLogout: () => void;
  onSession: (session: Session) => void;
}) {
  const [client, setClient] = useState<"codex" | "gpt">(
    readPreference("client", "codex") === "gpt" ? "gpt" : "codex",
  );
  useEffect(() => {
    try {
      localStorage.setItem("codex-client", client);
    } catch {}
  }, [client]);
  const navigationState = useNavigation();
  const [initialized, setInitialized] = useState(false),
    [wide, setWide] = useState(window.innerWidth >= 1100);
  const [projects, setProjects] = useState<Project[]>([]),
    [threads, setThreads] = useState<Thread[]>([]);
  const [threadGroups, setThreadGroups] = useState<Record<string, Thread[]>>({});
  const [sending, setSending] = useState(false),
    [sendError, setSendError] = useState("");
  const [writeBlocked, setWriteBlocked] = useState(false);
  const sendingRef = useRef(false);
  const [machines, setMachines] = useState<Machine[]>([]),
    [createProject, setCreateProject] = useState(false),
    [syncing, setSyncing] = useState(false),
    [remoteImmersive, setRemoteImmersive] = useState(false),
    [resultOverlay, setResultOverlay] = useState(false);
  const threadRequest = useRef(0);
  const [projectId, setProjectId] = useState(""),
    [threadId, setThreadId] = useState(""),
    [view, setView] = useState<View>("chat"),
    [theme, setTheme] = useState<Theme>(cachedTheme);
  const selectionRef = useRef({ projectId, threadId });
  selectionRef.current = { projectId, threadId };
  const [drawer, setDrawer] = useState(false),
    [settings, setSettings] = useState(false),
    [navCollapsed, setNavCollapsed] = useState(false),
    [rightHidden, setRightHidden] = useState(readPreference("right-hidden", "false") === "true"),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState("");
  useEffect(() => {
    try {
      localStorage.setItem("codex-right-hidden", String(rightHidden));
    } catch {
      /* Optional preference. */
    }
  }, [rightHidden]);
  const [machine, setMachine] = useState<"checking" | "online" | "offline">("checking");
  const [results, setResults] = useState<Result[]>([]),
    [activity, setActivity] = useState<Activity[]>([]),
    [activityCursor, setActivityCursor] = useState<number | null>(null);
  const [notebook, setNotebook] = useState<NotebookRequest>();
  const [workspaceDestination, setWorkspaceDestination] = useState<WorkspaceDestination>();
  const [pendingNotebookResult, setPendingNotebookResult] = useState<{
    threadId: string;
    id: string;
  }>();
  const [machinePanel, setMachinePanel] = useState(false);
  const [fileFocus, setFileFocus] = useState({ path: "", version: 0, projectId: "" });
  const [resultScope, setResultScope] = useState<"thread" | "project">("thread");
  const [libraryRevision, setLibraryRevision] = useState(0);
  const [pendingResultTurn, setPendingResultTurn] = useState<{
    threadId: string;
    turnId: string;
  }>();
  useEffect(() => {
    if (resultScope !== "project" || !["results", "chat"].includes(view)) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") setLibraryRevision((v) => v + 1);
    }, 5000);
    return () => clearInterval(timer);
  }, [resultScope, view]);
  const [resultCount, setResultCount] = useState(0);
  const [resultCategory, setResultCategory] = useState<ResultCategory>("all");
  const [resultFocusVersion, setResultFocusVersion] = useState(0);
  const [focusResult, setFocusResult] = useState(""),
    [focusTurn, setFocusTurn] = useState("");
  // biome-ignore lint/correctness/useExhaustiveDependencies: A new conversation clears its predecessor's result navigation.
  useEffect(() => {
    setFocusResult("");
    setResultFocusVersion(0);
    setResultCategory("all");
  }, [threadId]);
  const [rightWidth, setRightWidth] = useState(Number(readPreference("right-width", "38")));
  const root = useRef<HTMLDivElement>(null),
    settingsDialog = useRef<HTMLDialogElement>(null),
    drawerDialog = useProjectDrawer(drawer);
  useProjectSwipe(drawerDialog, drawer, () => setDrawer(false), "close");
  useProjectSwipe(settingsDialog, settings, () => setSettings(false), "close");
  useProjectSwipe(
    root,
    client === "codex" &&
      view !== "remote" &&
      !drawer &&
      !settings &&
      !createProject &&
      !resultOverlay,
    () => setDrawer(true),
  );
  const { state, older, reconnect, refresh } = useWorkspace(threadId);
  useNotificationPresence(
    "codex",
    threadId,
    client === "codex" && view === "chat" && !settings && !drawer && !machinePanel && !notebook,
  );
  const [notificationTarget, setNotificationTarget] = useState<NotificationTarget | undefined>();
  const notificationHandled = useCallback((id: string) => {
    clearNotification(id);
    setNotificationTarget(undefined);
  }, []);
  const notificationSelection = useRef<
    { id: string; projectId: string; threadId: string } | undefined
  >(undefined);
  const selectionSave = useRef<Promise<unknown>>(Promise.resolve());
  const notificationVersion = useRef(0);
  useEffect(() => {
    if (!initialized) return;
    let disposed = false;
    const open = (id: string) => {
      if (!/^[a-f0-9]{32}$/.test(id)) return;
      const version = ++notificationVersion.current;
      void api<Omit<NotificationTarget, "id">>("/push/open/" + id, { timeoutMs: 10000 })
        .then((target) => {
          if (disposed || version !== notificationVersion.current) return;
          setDrawer(false);
          setSettings(false);
          setView("chat");
          setClient(target.client);
          if (target.client === "gpt") setNotificationTarget({ ...target, id });
          else if (target.threadId && target.projectId) {
            // The target can be older than the first catalog page; do not replace it with page[0].
            notificationSelection.current = {
              id,
              projectId: target.projectId,
              threadId: target.threadId,
            };
            threadRequest.current++;
            setProjectId(target.projectId);
            setThreadId(target.threadId);
            setThreads([]);
          }
        })
        .catch((e) => {
          if (!disposed) setNotice(messageOf(e));
        });
    };
    const hash = () => open(new URLSearchParams(location.hash.slice(1)).get("notification") || "");
    hash();
    window.addEventListener("hashchange", hash);
    return () => {
      disposed = true;
      window.removeEventListener("hashchange", hash);
    };
  }, [initialized]);
  const storedProject = projects.find((p) => p.id === projectId);
  const project = storedProject
    ? {
        ...storedProject,
        ...navigationState.state.library?.find((e) => e.kind === "project" && e.id === projectId),
      }
    : undefined;
  const selectedThread = threads.find((t) => t.id === threadId);
  const selectedThreadTitle =
    navigationState.state.threads.find((t) => t.id === threadId)?.title ?? selectedThread?.title;
  useEffect(() => {
    if (
      initialized &&
      project &&
      !project.unassigned &&
      !threadId &&
      threadGroups[projectId]?.length === 0 &&
      !state.loading &&
      !busy &&
      view === "chat"
    )
      setView("overview");
  }, [initialized, project, projectId, threadGroups, threadId, state.loading, busy, view]);
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
  const loadThreads = useCallback(async (id: string, selected?: string | null) => {
    const request = ++threadRequest.current;
    const data = await api<{ threads: Thread[]; warning?: string }>(`/projects/${id}/threads`);
    if (request !== threadRequest.current) return;
    setThreads(data.threads);
    setThreadGroups((groups) => ({ ...groups, [id]: data.threads }));
    if (data.warning) setNotice(data.warning);
    setThreadId((current) =>
      selected === null
        ? ""
        : selected && data.threads.some((t) => t.id === selected)
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
          api<{ projectId?: string; threadId?: string | null; theme?: Theme; view?: View }>(
            "/preferences",
          ),
          api<{ machines: Machine[] }>("/machines"),
        ]);
        setMachines(machineList.machines);
        setProjects(list);
        if (prefs.theme) setTheme(prefs.theme);
        if (prefs.view) setView(prefs.view);
        const visible = list.filter((p) => !p.archived && !p.deleted);
        const id = visible.some((p) => p.id === prefs.projectId)
          ? (prefs.projectId ?? "")
          : (visible[0]?.id ?? "");
        setProjectId(id);
        if (id)
          await loadThreads(
            id,
            prefs.view === "overview" && !prefs.threadId ? null : (prefs.threadId ?? undefined),
          );
        setInitialized(true);
      } catch (e) {
        setNotice(messageOf(e));
      }
    })();
  }, [loadThreads]);
  useEffect(() => {
    applyTheme(theme);
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
    if (!projectId || view === "overview") return;
    let disposed = false;
    setMachine("checking");
    void api<{ available: boolean; code?: string }>(`/projects/${projectId}/status`)
      .then((s) => {
        if (!disposed) {
          setMachine(s.available ? "online" : "offline");
          if (!s.available && s.code === "CODEX_LOGIN_REQUIRED")
            setNotice("На машине выполнения нужен вход в Codex.");
          if (
            !s.available &&
            [
              "CODEX_METHOD_UNSUPPORTED",
              "INVALID_CODEX_PROTOCOL",
              "INVALID_CODEX_RESPONSE",
            ].includes(s.code ?? "")
          )
            setNotice(
              "Установленный Codex несовместим с этим подключением. Проверь диагностику сервера.",
            );
        }
      })
      .catch(() => {
        if (!disposed) setMachine("offline");
      });
    return () => {
      disposed = true;
    };
  }, [projectId, view]);
  useEffect(() => {
    if (!projectId) return;
    // Keep the notification URL recoverable until this selection is durable.
    // Serialize selection writes so a slow predecessor cannot replace the target.
    const target = notificationSelection.current;
    selectionSave.current = selectionSave.current
      .catch(() => {})
      .then(() =>
        api("/preferences", {
          method: "PATCH",
          body: { projectId, threadId: threadId || null, view },
        }),
      )
      .then(() => {
        if (
          target &&
          target === notificationSelection.current &&
          target.projectId === projectId &&
          target.threadId === threadId
        ) {
          clearNotification(target.id);
          notificationSelection.current = undefined;
        }
      })
      .catch(() => {});
  }, [projectId, threadId, view]);
  const resultRequest = useRef(0);
  const loadResults = useCallback(async () => {
    const request = ++resultRequest.current;
    if (!threadId) {
      setResults([]);
      setResultCount(0);
      return;
    }
    const data = await api<{ items: Result[]; nextBefore: number | null; counts: { all: number } }>(
      `/threads/${threadId}/results`,
    );
    if (request !== resultRequest.current || selectionRef.current.threadId !== threadId) return;
    setResults(data.items);
    setResultCount(data.counts.all);
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
    if (settings) {
      const panel = settingsDialog.current;
      if (panel) {
        panel.tabIndex = -1;
        panel.showModal();
        panel.focus({ preventScroll: true });
      }
    } else settingsDialog.current?.close();
  }, [settings]);
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
  const openMachineProject = (id: string, remote: boolean) => {
    if (!projects.some((p) => p.id === id))
      void api<{ projects: Project[] }>("/projects")
        .then((data) => setProjects(data.projects))
        .catch((e) => setNotice(messageOf(e)));
    setClient("codex");
    setMachinePanel(false);
    if (id !== projectId) {
      setProjectId(id);
      setThreads(threadGroups[id] ?? []);
      setThreadId("");
      void loadThreads(id).catch((e) => setNotice(messageOf(e)));
    }
    setView(remote ? "remote" : "chat");
    if (remote) setRightHidden(false);
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
    const scope = "codex:" + threadId;
    try {
      const key = pendingSendKey(scope, signature);
      await api(`/threads/${threadId}/turns`, {
        method: "POST",
        key,
        body: { text, settings, attachments },
      });
      completePendingSend(scope, key);
      // Metadata refresh cannot turn an acknowledged send into a failed send.
      void loadThreads(projectId, threadId).catch(() => {});
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.code === "MACHINE_RELEASED") throw error;
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
  const resume = async (): Promise<RecoveryOutcome> => {
    if (busy) return { ok: false, message: "Дождись завершения текущего действия." };
    setBusy(true);
    setNotice("");
    const selected = threadId;
    try {
      const restored = await api<Thread>(`/threads/${selected}/resume`, {
        method: "POST",
        timeoutMs: 60000,
      });
      if (selectionRef.current.threadId !== selected)
        return { ok: true, message: "Диалог восстановлен." };
      setSendError("");
      setWriteBlocked(false);
      // Recover access only: the owner decides when to send the preserved draft.
      await refresh().catch(() => {});
      reconnect();
      if (restored.status === "unknown")
        return { ok: false, message: "Состояние работы пока не подтверждено. Повтори проверку." };
      return {
        ok: true,
        message:
          restored.status === "running" || restored.status === "starting"
            ? "Связь восстановлена. Codex продолжает работу."
            : restored.status === "waiting_approval"
              ? "Связь восстановлена. Codex ждёт ответа."
              : "Диалог восстановлен. Чтобы продолжить задачу, отправь сообщение.",
      };
    } catch (error) {
      if (selectionRef.current.threadId === selected)
        setWriteBlocked(error instanceof ApiError && error.code === "THREAD_IN_USE");
      return { ok: false, message: messageOf(error) };
    } finally {
      setBusy(false);
    }
  };
  const showResult = (id: string, category: ResultCategory = "all") => {
    setResultScope("thread");
    setResultCategory(category);
    setResultFocusVersion((v) => v + 1);
    setRightHidden(false);
    setFocusResult(id);
    setView("results");
  };
  const openProjectOverview = (id: string) => {
    threadRequest.current++;
    if (id !== projectId) {
      setProjectId(id);
      setThreadId("");
      setThreads(threadGroups[id] ?? []);
    }
    setView("overview");
    setDrawer(false);
  };
  const openNotebookTarget = (target: NotebookLink) => {
    if (target.kind === "note" || target.kind === "task") {
      setNotebook({
        scope: notebook?.scope ?? null,
        mode: target.kind === "task" ? "tasks" : "notes",
        itemId: target.id,
      });
      return;
    }
    setNotebook(undefined);
    if (target.client === "gpt") {
      setWorkspaceDestination({ target, version: Date.now() });
      setClient("gpt");
      return;
    }
    setClient("codex");
    if (target.kind === "project") {
      openMachineProject(target.id, false);
      return;
    }
    if (target.kind === "file" && target.projectId) {
      openMachineProject(target.projectId, false);
      setFileFocus({ path: target.id, projectId: target.projectId, version: Date.now() });
      setRightHidden(false);
      setView("files");
      return;
    }
    if (target.threadId) {
      selectThread(target.threadId, target.projectId);
      if (target.kind === "result")
        setPendingNotebookResult({ threadId: target.threadId, id: target.id });
      else if (target.turnId)
        setPendingResultTurn({ threadId: target.threadId, turnId: target.turnId });
    }
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: Consume an explicit target once after its history mounts.
  useEffect(() => {
    if (
      !pendingNotebookResult ||
      state.loading ||
      state.thread.id !== pendingNotebookResult.threadId
    )
      return;
    showResult(pendingNotebookResult.id);
    setPendingNotebookResult(undefined);
  }, [pendingNotebookResult, state.loading, state.thread.id]);
  const notebookPanel = (
    <NotebookPanel
      request={notebook}
      onClose={() => setNotebook(undefined)}
      onOpen={openNotebookTarget}
      onRequest={setNotebook}
    />
  );
  const openNotebook = (mode: "notes" | "tasks" = "notes") => {
    setDrawer(false);
    setSettings(false);
    setNotebook({
      mode,
      scope:
        project && !project.unassigned
          ? { client: "codex", projectId: project.id, name: project.name }
          : null,
      target: threadId
        ? {
            client: "codex",
            kind: "thread",
            id: threadId,
            threadId,
            projectId,
            title: state.thread.title || "Диалог Codex",
          }
        : undefined,
    });
  };
  const showTurn = async (id: string) => {
    const selected = threadId;
    if (!state.messages.some((m) => m.turnId === id)) {
      setNotice("Это сообщение выше в истории. Подгружаем нужный фрагмент…");
      // A bounded context request avoids downloading the whole conversation.
      const context = await api<History>(
        `/threads/${threadId}/history?turnId=${encodeURIComponent(id)}`,
      );
      if (selectionRef.current.threadId !== selected) return;
      window.dispatchEvent(
        new CustomEvent("codex-focus-history", { detail: { threadId, history: context } }),
      );
      setNotice("");
    }
    setFocusTurn("");
    setView("chat");
    requestAnimationFrame(() => setFocusTurn(id));
  };
  // The destination history must mount before fetching an older result's turn context.
  // biome-ignore lint/correctness/useExhaustiveDependencies: This consumes each explicit navigation once after the selected history loads.
  useEffect(() => {
    if (!pendingResultTurn || state.loading || state.thread.id !== pendingResultTurn.threadId)
      return;
    const target = pendingResultTurn;
    setPendingResultTurn(undefined);
    void showTurn(target.turnId).catch((e) => setNotice(messageOf(e)));
  }, [pendingResultTurn, state.loading, state.thread.id]);
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
        const available = data.projects.filter((p) => !p.archived && !p.deleted);
        const project = available.find((p) => p.id === selected.projectId) ?? available[0];
        if (project) {
          setProjectId(project.id);
          await loadThreads(project.id, selected.threadId);
        } else {
          setProjectId("");
          setThreadId("");
          setThreads([]);
        }
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
  useEffect(() => {
    const changed = (event: Event) => {
      const detail = (event as CustomEvent<LibraryChange>).detail;
      if (detail.client !== "codex") return;
      if (detail.kind === "thread") {
        setThreadGroups((groups) =>
          Object.fromEntries(
            Object.entries(groups).map(([id, rows]) => [
              id,
              rows
                .filter(
                  (t) =>
                    t.id !== detail.id ||
                    !["archive", "delete"].includes(detail.action) ||
                    detail.value === false,
                )
                .map((t) =>
                  t.id === detail.id
                    ? {
                        ...t,
                        title: detail.action === "rename" ? detail.name : t.title,
                        pinned: detail.action === "pin" ? detail.value : t.pinned,
                      }
                    : t,
                ),
            ]),
          ),
        );
      }
      void refreshCatalog();
    };
    window.addEventListener(libraryEvent, changed);
    return () => window.removeEventListener(libraryEvent, changed);
  }, [refreshCatalog]);
  useEffect(() => {
    const library = navigationState.state.library ?? [];
    const selected = selectionRef.current;
    if (
      library.some(
        (e) =>
          (e.archived || e.deleted) &&
          ((e.kind === "thread" && e.id === selected.threadId) ||
            (e.kind === "project" && e.id === selected.projectId)),
      )
    )
      void refreshCatalog();
  }, [navigationState.state.library, refreshCatalog]);
  const navigation = (
    <ProjectNavigation
      onClient={(value) => {
        setDrawer(false);
        setClient(value);
      }}
      projects={projects}
      activity={navigationState.state}
      threadGroups={threadGroups}
      projectId={projectId}
      threadId={threadId}
      busy={busy}
      loading={!initialized || syncing}
      machine={machine}
      onExpand={expandProject}
      onNotebook={() => openNotebook()}
      onPlan={() => openNotebook("tasks")}
      onOverview={openProjectOverview}
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
      onClick={() => {
        if (name !== "chat") setRightHidden(false);
        setView(name);
      }}
      aria-current={view === name ? "page" : undefined}
    >
      <Icon name={icon} />
      <span>{label}</span>
      {name === "results" && resultCount > 0 && <span className="tab-count">{resultCount}</span>}
    </button>
  );
  if (client === "gpt")
    return (
      <>
        {notebookPanel}
        <GptLoadBoundary onCodex={() => setClient("codex")}>
          <Suspense
            fallback={
              <div className="boot-screen">
                <span className="spinner" />
              </div>
            }
          >
            <GptWorkspace
              notificationTarget={notificationTarget}
              onNotificationHandled={notificationHandled}
              onCodex={() => setClient("codex")}
              onCodexProject={openMachineProject}
              onWorkspaceTarget={openNotebookTarget}
              onNotebook={setNotebook}
              notebookOpen={!!notebook}
              workspaceDestination={workspaceDestination}
              theme={theme}
              onTheme={setTheme}
              onSession={onSession}
              onLogout={onLogout}
            />
          </Suspense>
        </GptLoadBoundary>
      </>
    );
  return (
    <div
      className={`workspace ${navCollapsed ? "nav-collapsed" : ""}`}
      data-view={view}
      data-right-hidden={rightHidden}
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
        <button
          type="button"
          className="header-project overview-trigger"
          aria-label="Обзор текущего проекта"
          disabled={!project || project.unassigned}
          onClick={() => project && openProjectOverview(project.id)}
        >
          <span>
            <Icon name="folder" size={17} />
            {project?.name ?? "Рабочее пространство"}
          </span>
          <small>
            {view === "overview" ? "Обзор проекта" : (selectedThreadTitle ?? "Выбери диалог")}
          </small>
        </button>
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
          className="icon-button wide-pane-control"
          aria-label="Открыть Remote"
          title="Remote"
          onClick={() => {
            setRightHidden(false);
            setView("remote");
          }}
        >
          <Icon name="remote" />
        </button>
        <button
          type="button"
          className="icon-button wide-pane-control"
          aria-label={rightHidden ? "Показать правую панель" : "Скрыть правую панель"}
          title={rightHidden ? "Показать правую панель" : "Скрыть правую панель"}
          aria-expanded={!rightHidden}
          aria-controls="support-panel"
          onClick={() => setRightHidden((value) => !value)}
        >
          <Icon name="panel-right" />
        </button>
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
        {view === "overview" && project && !project.unassigned && (
          <ProjectOverview
            key={projectId}
            scope={{ client: "codex", projectId, name: project.name }}
            onTarget={openNotebookTarget}
            onNotebook={setNotebook}
            onNew={() => newThread(projectId)}
            onFiles={() => {
              setView("files");
              setRightHidden(false);
            }}
            onResults={() => {
              setResultScope("project");
              setFocusResult("");
              setView("results");
              setRightHidden(false);
            }}
            onMachines={() => setMachinePanel(true)}
            onRemote={() => {
              setView("remote");
              setRightHidden(false);
            }}
          />
        )}
        <Chat
          machineId={project?.machineId}
          projectId={projectId}
          threadId={threadId}
          state={state}
          sending={sending}
          sendError={sendError}
          writeBlocked={writeBlocked}
          visible={view !== "overview" && (wide || view === "chat")}
          canMarkSeen={
            view !== "overview" &&
            !pendingNotebookResult &&
            !drawer &&
            !settings &&
            !machinePanel &&
            !notebook &&
            !createProject &&
            !remoteImmersive &&
            !resultOverlay &&
            navigationState.connected
          }
          completion={navigationState.state.threads.find((t) => t.id === threadId)}
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
        <div className="support-pane" id="support-panel">
          <div className="support-tabs">
            {tab("results", "Результаты", "results")}
            {tab("files", "Файлы", "folder")}
            {tab("activity", "Активность", "activity")}
            {tab("remote", "Remote", "remote")}
          </div>
          <ResultFeed
            onSaveLink={(r) =>
              setNotebook({
                scope: project
                  ? { client: "codex", projectId: project.id, name: project.name }
                  : null,
                target: {
                  client: "codex",
                  kind: "result",
                  id: r.id,
                  title: r.title,
                  threadId: r.threadId ?? threadId,
                  projectId,
                  turnId: r.turnId ?? undefined,
                },
              })
            }
            onFile={(raw) => {
              const root = (project?.workingDirectory ?? "")
                .replaceAll("\\", "/")
                .replace(/\/$/, "");
              let path = raw.replaceAll("\\", "/");
              const matches = /^[A-Za-z]:/.test(root)
                ? path.toLowerCase().startsWith(root.toLowerCase() + "/")
                : path.startsWith(root + "/");
              if (matches) path = path.slice(root.length + 1);
              if (/^(?:\/|[A-Za-z]:)/.test(path)) {
                setNotice("Файл находится вне выбранного проекта.");
                return;
              }
              setFileFocus((v) => ({ path, version: v.version + 1, projectId }));
              setRightHidden(false);
              setView("files");
            }}
            key={
              resultScope === "project"
                ? `project-results:${projectId}`
                : `thread-results:${threadId}`
            }
            endpoint={
              resultScope === "project"
                ? "/projects/" + projectId + "/results"
                : threadId
                  ? "/threads/" + threadId + "/results"
                  : ""
            }
            revision={
              String(state.revision) +
              ":" +
              libraryRevision +
              ":" +
              results.map((r) => r.id).join(",")
            }
            toolbar={
              <fieldset className="result-scope" aria-label="Область результатов">
                <button
                  type="button"
                  aria-pressed={resultScope === "thread"}
                  onClick={() => {
                    setFocusResult("");
                    setResultScope("thread");
                  }}
                >
                  Диалог
                </button>
                <button
                  type="button"
                  aria-pressed={resultScope === "project"}
                  onClick={() => {
                    setFocusResult("");
                    setResultScope("project");
                  }}
                >
                  Весь проект
                </button>
              </fieldset>
            }
            onOverlayChange={setResultOverlay}
            visible={view === "results" || view === "chat"}
            focusId={focusResult}
            focusCategory={resultCategory}
            focusVersion={resultFocusVersion}
            onTurn={(id, source) => {
              if (source && source !== threadId) {
                threadRequest.current++;
                setThreadId(source);
                setView("chat");
                setPendingResultTurn({ threadId: source, turnId: id });
              } else void showTurn(id).catch((e) => setNotice(messageOf(e)));
            }}
          />
          <ProjectFiles
            key={`project-files:${projectId}`}
            projectId={projectId}
            visible={view === "files"}
            focus={fileFocus}
            onBack={() => setView("chat")}
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
            visible={view === "remote" && (!wide || !rightHidden)}
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
      <dialog
        className="project-sheet"
        aria-label="Проекты и диалоги"
        ref={drawerDialog}
        onCancel={(event) => {
          event.preventDefault();
          setDrawer(false);
        }}
      >
        <div className="sheet-content">{navigation}</div>
      </dialog>
      <dialog className="settings-dialog" ref={settingsDialog} onCancel={() => setSettings(false)}>
        <div className="dialog-heading">
          <h2>Настройки</h2>
          <button
            type="button"
            className="icon-button panel-close"
            onClick={() => setSettings(false)}
            aria-label="Закрыть настройки"
          >
            <Icon name="close" />
          </button>
        </div>
        <fieldset className="theme-picker">
          <legend>Оформление</legend>
          {themes.map(({ id, title, description }) => (
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
        <UsageLimits machines={machines} open={settings} />
        <DesktopControl
          machines={machines}
          open={settings}
          threadId={threadId}
          machineId={project?.machineId}
        />
        <button
          type="button"
          className="secondary settings-activity"
          onClick={() => {
            setRightHidden(false);
            setView("activity");
            setSettings(false);
          }}
        >
          <Icon name="activity" />
          Активность диалога
        </button>
        {project && !project.unassigned && (
          <button
            type="button"
            className="secondary"
            onClick={() => {
              setRightHidden(false);
              setView("files");
              setSettings(false);
            }}
          >
            <Icon name="folder" />
            Файлы и Git проекта
          </button>
        )}
        <button
          type="button"
          className="secondary"
          onClick={() => {
            setSettings(false);
            setMachinePanel(true);
          }}
        >
          <Icon name="remote" />
          Компьютеры
        </button>
        <Notifications visible={settings} />
        <StorageUsage visible={settings} />
        <AccountControls onSession={onSession} onLogout={onLogout} />
        <p className="small muted">Для установки на iPhone: Поделиться → На экран «Домой».</p>
      </dialog>
      {notebookPanel}
      <MachineHealthPanel
        open={machinePanel}
        onClose={() => setMachinePanel(false)}
        onMaintenance={() => {
          setMachinePanel(false);
          setSettings(true);
        }}
        onProject={openMachineProject}
      />
    </div>
  );
}
