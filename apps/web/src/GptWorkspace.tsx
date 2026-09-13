import type {
  GptConnection,
  GptConversation,
  GptFile,
  GptJob,
  GptModels,
  GptProject,
  NotebookLink,
  ResultCategory,
  ResultItem,
} from "@codex-web/shared";
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AccountControls } from "./AccountControls";
import { AppearanceSettings } from "./AppearanceSettings";
import {
  accountLocalStorage as localStorage,
  accountSessionStorage as sessionStorage,
} from "./accountStorage.ts";
import { api, messageOf } from "./api";
import { BridgeDoctorPanel } from "./BridgeDoctorPanel";
import CanvasPanel from "./CanvasPanel";
import { CollapsibleCode } from "./CollapsibleCode";
import { openContentSearch } from "./ContentSearch";
import { CopyButton } from "./CopyButton";
import { DeploymentStatus } from "./DeploymentStatus";
import { useDictation } from "./Dictation";
import { DownloadLink, isDownloadUrl } from "./DownloadLink";
import {
  EntityArchive,
  EntityMenu,
  type LibraryChange,
  type LibraryEntity,
  libraryEvent,
} from "./EntityMenu";
import { useGptNativeOperations } from "./GptNativeOperations";
import { GptProgress } from "./GptProgress";
import { GptProjectPending } from "./GptProjectContent";
import { beginGptHistory, gptCache, saveGptCache } from "./gptCache";
import { mergeGptJobs, showGptJob } from "./gptState";
import { Icon } from "./icons";
import { MachineHealthPanel } from "./MachineHealth";
import { MarkdownTable } from "./MarkdownTable";
import { SpeechButton, SpeechSettings, useSpeechScope } from "./MessageSpeech";
import { NavigationFooter } from "./NavigationFooter";
import type { NotebookRequest, WorkspaceDestination } from "./Notebook";
import { Notifications, type NotificationTarget, useNotificationPresence } from "./Notifications";
import { PinnedList } from "./PinnedList";
import { ProjectOverviewModal } from "./ProjectOverviewModal";
import { clearAcknowledgedSend, completePendingSend, pendingSendKey } from "./pendingSend";
import { ResultFeed } from "./ResultFeed";
import { SettingsSections } from "./SettingsSections";
import { StorageUsage } from "./StorageUsage";
import type { Theme } from "./theme";
import type { Session } from "./types";
import { useCompletionPosition } from "./useCompletionPosition";
import { useGptHistory } from "./useGptHistory";
import { useGrowingComposer } from "./useGrowingComposer";
import { useProjectDrawer } from "./useProjectDrawer";
import { useProjectSwipe } from "./useProjectSwipe";
import { useThreadReviews, WorkReviewLink } from "./WorkReviewLink";
import { WorkspaceLinks } from "./WorkspaceLinks";
import "./gpt.css";

const isActive = (job: GptJob) => ["queued", "preparing", "running"].includes(job.status);
const titles: Record<GptJob["status"], string> = {
  queued: "В очереди",
  preparing: "Подготовка сообщения",
  running: "GPT работает",
  completed: "Готово",
  failed: "Не отправлено",
  unknown: "Нужна проверка",
  cancelled: "Остановлено",
};
const Files = memo(function Files({ files }: { files: GptFile[] }) {
  return (
    <div className="gpt-files">
      {files.map((file) => (
        <DownloadLink key={file.id} href={file.url} name={file.name} className="gpt-file-download">
          {file.image ? (
            <img src={file.url} alt={file.name} loading="lazy" />
          ) : (
            <>
              <Icon name="file" />
              <span>{file.name}</span>
            </>
          )}
        </DownloadLink>
      ))}
    </div>
  );
});
const Text = memo(function Text({ value }: { value: string }) {
  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      components={{
        pre: CollapsibleCode,
        table: MarkdownTable,
        a: ({ node: _node, ...props }) =>
          isDownloadUrl(props.href) ? (
            <DownloadLink href={props.href} className="download-text">
              {props.children}
            </DownloadLink>
          ) : !props.href ? (
            <span>{props.children}</span>
          ) : (
            <a
              {...props}
              className={props.title === "Источник" ? "source-link" : undefined}
              target="_blank"
              rel="noopener noreferrer"
            />
          ),
      }}
    >
      {value}
    </Markdown>
  );
});
function ResponseResults({
  text,
  files,
  onOpen,
}: {
  text: string;
  files: GptFile[];
  onOpen: (category: ResultCategory) => void;
}) {
  const demo = /(?:^|\n)(?:\x60{3}|~{3})html[ \t]*\r?\n[\s\S]*?\r?\n(?:\x60{3}|~{3})(?=\s|$)/i.test(
    text,
  );
  if (!files.length && !demo) return null;
  const category = demo
    ? files.length
      ? "all"
      : "demos"
    : files.every((file) => file.image)
      ? "images"
      : files.every((file) => !file.image)
        ? "files"
        : "all";
  return (
    <button type="button" className="result-chip" onClick={() => onOpen(category)}>
      <Icon name="results" size={16} />
      Результаты ответа
      <Icon name="chevron" size={14} />
    </button>
  );
}
function cachedId() {
  try {
    return localStorage.getItem("gpt-conversation") ?? "";
  } catch {
    return "";
  }
}
export function GptWorkspace({
  notificationTarget,
  onNotificationHandled,
  onCodex,
  onCodexProject,
  onWorkspaceTarget,
  onNotebook,
  notebookOpen = false,
  workspaceDestination,
  theme,
  onTheme,
  onSession,
  onLogout,
}: {
  onCodex: () => void;
  onCodexProject?: (id: string, remote: boolean) => void;
  onWorkspaceTarget?: (target: NotebookLink) => void;
  onNotebook?: (request: NotebookRequest) => void;
  notebookOpen?: boolean;
  workspaceDestination?: WorkspaceDestination;
  theme: Theme;
  onTheme: (theme: Theme) => void;
  notificationTarget?: NotificationTarget;
  onNotificationHandled: (id: string) => void;
  onSession: (session: Session) => void;
  onLogout: () => void;
}) {
  const [overviewProject, setOverviewProject] = useState<GptProject | null>(null);
  const [machinePanel, setMachinePanel] = useState(false);
  const connectionRequest = useRef(0);
  const [connection, setConnection] = useState<GptConnection | null>(null);
  const [checkingConnection, setCheckingConnection] = useState(false);
  const checkConnection = async () => {
    setCheckingConnection(true);
    const request = ++connectionRequest.current;
    try {
      const next = await api<GptConnection>("/gpt/reconnect", { method: "POST" });
      if (request === connectionRequest.current) {
        setConnection(next);
        setReady(next.canSend);
      }
      if (next.canSend) {
        const catalog = await api<GptModels>("/gpt/models");
        setModels(catalog);
        setModel((old) =>
          catalog.models.some((item) => item.id === old) ? old : catalog.currentModel,
        );
        setEffort((old) =>
          catalog.efforts.some((item) => item.id === old) ? old : catalog.currentEffort,
        );
        gptCache.models = catalog;
      }
    } catch (e) {
      setNotice(messageOf(e));
    } finally {
      setCheckingConnection(false);
    }
  };
  const [items, setItems] = useState<GptConversation[]>(gptCache.items),
    [projects, setProjects] = useState<GptProject[]>(gptCache.projects),
    [offset, setOffset] = useState<number | null>(gptCache.offset);
  const [createdJob, setCreatedJob] = useState(() => {
    try {
      return sessionStorage.getItem("gpt-created-job") || "";
    } catch {
      return "";
    }
  });
  const [selected, setSelected] = useState(cachedId);
  const reviews = useThreadReviews("gpt", selected);
  const [jobs, setJobs] = useState<GptJob[]>(gptCache.jobs),
    [models, setModels] = useState<GptModels | null>(gptCache.models),
    [model, setModel] = useState(gptCache.model),
    [effort, setEffort] = useState(gptCache.effort);
  const [text, setText] = useState(""),
    [files, setFiles] = useState<GptFile[]>([]),
    [busy, setBusy] = useState(false),
    [uploading, setUploading] = useState(false);
  const [loadNotice, setLoadNotice] = useState("");
  const [notice, setNotice] = useState(""),
    [drawer, setDrawer] = useState(false),
    [settings, setSettings] = useState(false),
    [view, setView] = useState<"chat" | "results" | "overview">("chat");
  const [search, setSearch] = useState(""),
    [ready, setReady] = useState(false),
    [rightHidden, setRightHidden] = useState(false);
  const [navCollapsed, setNavCollapsed] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const root = useRef<HTMLDivElement>(null),
    drawerRef = useProjectDrawer(drawer),
    settingsRef = useRef<HTMLDialogElement>(null),
    input = useRef<HTMLInputElement>(null),
    messageList = useRef<HTMLDivElement>(null),
    userScrollUntil = useRef(0);
  const selectedRef = useRef(selected),
    sending = useRef(false),
    draftLoaded = useRef(""),
    skipDraftSave = useRef(false),
    navigationVersion = useRef(0);
  const draftScope = selected || (createdJob ? "job:" + createdJob : "");
  const draftScopeRef = useRef(draftScope);
  draftScopeRef.current = draftScope;
  const previousJobs = useRef<GptJob[]>(gptCache.jobs);
  const {
    messages,
    before,
    loading,
    ready: historyReady,
    stale: historyStale,
    revalidating,
    scroll,
    sticky,
    history,
    rememberScroll,
    contextMessage,
    hasNewer,
    error: historyNotice,
  } = useGptHistory(selected);
  const [canvasOpen, setCanvasOpen] = useState(false);
  const nativeOperations = useGptNativeOperations(
    selected,
    { model, effort },
    (id) => {
      if (selectedRef.current === id) void history(id, undefined, true).catch(() => {});
    },
    (id) => {
      choose(id);
      void catalog().catch(() => {});
    },
  );
  selectedRef.current = selected;
  useProjectSwipe(drawerRef, drawer, () => setDrawer(false), "close");
  useProjectSwipe(settingsRef, settings, () => setSettings(false), "close");
  useProjectSwipe(root, !drawer && !settings && !machinePanel && !notebookOpen, () =>
    setDrawer(true),
  );
  const action = useCallback(async (fn: () => Promise<void>) => {
    const version = navigationVersion.current;
    try {
      await fn();
    } catch (e) {
      if (navigationVersion.current === version) setNotice(messageOf(e));
    }
  }, []);
  const catalogVersion = useRef(0);
  const catalog = useCallback(async (append = false, next = 0, force = true) => {
    if (!append && !force && Date.now() - gptCache.catalogAt < 30000) return;
    const version = catalogVersion.current;
    const data = await api<{
      items: GptConversation[];
      nextOffset: number | null;
      pinnedIds?: string[];
      library?: LibraryEntity[];
    }>("/gpt/conversations?offset=" + next);
    if (version !== catalogVersion.current) return;
    gptCache.catalogAt = Date.now();
    const metadata = new Map(
      (data.library ?? []).filter((e) => e.kind === "thread").map((e) => [e.id, e]),
    );
    setItems((old) =>
      [...new Map([...old, ...data.items].map((c) => [c.id, c])).values()].map((row) => ({
        ...row,
        title: metadata.get(row.id)?.name || row.title,
        pinned: data.pinnedIds ? data.pinnedIds.includes(row.id) : row.pinned,
        archived: metadata.get(row.id)?.archived ?? row.archived,
        deleted: metadata.get(row.id)?.deleted ?? row.deleted,
      })),
    );
    setOffset((old) =>
      !append && next === 0 && old !== null
        ? Math.max(old, data.nextOffset ?? 0) || null
        : data.nextOffset,
    );
  }, []);
  useEffect(() => {
    const refresh = async () => {
      const version = catalogVersion.current;
      await catalog();
      const data = await api<{ items: GptProject[]; conversations: GptConversation[] }>(
        "/gpt/projects",
      );
      if (version !== catalogVersion.current) return;
      setProjects(data.items);
      setItems((old) => [
        ...new Map([...data.conversations, ...old].map((t) => [t.id, t])).values(),
      ]);
      gptCache.projectsAt = Date.now();
    };
    const changed = (event: Event) => {
      const d = (event as CustomEvent<LibraryChange>).detail;
      if (d.client !== "gpt") return;
      catalogVersion.current++;
      const patch = {
        ...(d.action === "rename" ? { title: d.name, name: d.name } : {}),
        ...(d.action === "pin" ? { pinned: d.value } : {}),
        ...(d.action === "archive" ? { archived: d.value } : {}),
        ...(d.action === "delete" ? { deleted: true } : {}),
      };
      if (d.kind === "thread")
        setItems((old) => old.map((t) => (t.id === d.id ? { ...t, ...patch } : t)));
      else setProjects((old) => old.map((p) => (p.id === d.id ? { ...p, ...patch } : p)));
      if (
        (d.action === "delete" || (d.action === "archive" && d.value)) &&
        (d.id === selectedRef.current ||
          (d.kind === "project" &&
            items.some((t) => t.id === selectedRef.current && t.projectId === d.id)))
      )
        setSelected("");
      void refresh().catch((e) => setNotice(messageOf(e)));
    };
    const visible = () => {
      if (!document.hidden) void refresh().catch(() => {});
    };
    window.addEventListener(libraryEvent, changed);
    document.addEventListener("visibilitychange", visible);
    const timer = setInterval(visible, 30000);
    return () => {
      window.removeEventListener(libraryEvent, changed);
      document.removeEventListener("visibilitychange", visible);
      clearInterval(timer);
    };
  }, [catalog, items]);
  useEffect(() => {
    let disposed = false,
      attempt = 0;
    let retry: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const request = ++connectionRequest.current;
        const status = await api<GptConnection>("/gpt/status");
        if (disposed) return;
        if (request === connectionRequest.current) {
          setConnection(status);
          setReady(status.canSend);
        }
        if (!status.configured) {
          setLoadNotice("Подключение GPT ещё не настроено.");
          return;
        }
        await catalog(false, 0, false);
        if (disposed) return;
        if (!status.canSend && !gptCache.models) {
          retry = setTimeout(() => void load(), 5000);
          return;
        }
        const result = gptCache.models ?? (await api<GptModels>("/gpt/models"));
        if (disposed) return;
        setModels(result);
        setModel((old) => old || result.currentModel);
        setEffort((old) => old || result.currentEffort);
        setLoadNotice("");
      } catch (error) {
        if (disposed) return;
        attempt++;
        if (attempt >= 3) setLoadNotice(messageOf(error));
        // Only read catalog/settings metadata again; never repeat an action or send.
        retry = setTimeout(() => void load(), Math.min(15000, attempt * 2000));
      }
    };
    void load();
    if (Date.now() - gptCache.projectsAt >= 30000)
      void api<{ items: GptProject[]; conversations: GptConversation[] }>("/gpt/projects")
        .then((data) => {
          if (!disposed) {
            gptCache.projectsAt = Date.now();
            setProjects(data.items);
            setItems((old) => [
              ...new Map([...old, ...data.conversations].map((c) => [c.id, c])).values(),
            ]);
          }
        })
        .catch(() => {});
    return () => {
      disposed = true;
      clearTimeout(retry);
    };
  }, [catalog]);
  useLayoutEffect(() => {
    try {
      if (selected) localStorage.setItem("gpt-conversation", selected);
      else localStorage.removeItem("gpt-conversation");
      const draft = JSON.parse(sessionStorage.getItem("gpt-draft-" + draftScope) ?? "{}");
      setText(typeof draft.text === "string" ? draft.text : "");
      setFiles(Array.isArray(draft.files) ? draft.files : []);
    } catch {
      setText("");
      setFiles([]);
    }
    draftLoaded.current = draftScope;
    skipDraftSave.current = true;
    try {
      if (!selected && createdJob) sessionStorage.setItem("gpt-created-job", createdJob);
      else sessionStorage.removeItem("gpt-created-job");
    } catch {}
  }, [selected, createdJob, draftScope]);
  useEffect(() => {
    if (skipDraftSave.current) {
      skipDraftSave.current = false;
      return;
    }
    if (draftLoaded.current === draftScope)
      try {
        sessionStorage.setItem("gpt-draft-" + draftScope, JSON.stringify({ text, files }));
        clearAcknowledgedSend("gpt:" + draftScope);
      } catch {
        /* Optional draft cache. */
      }
  }, [draftScope, text, files]);
  useEffect(() => {
    let disposed = false,
      timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    let polling = false,
      stamp = gptCache.stamps[selected || createdJob] ?? 0;
    const poll = async () => {
      if (polling || disposed) return;
      clearTimeout(timer);
      polling = true;
      try {
        const query = new URLSearchParams({ after: String(stamp) });
        if (selected) query.set("nativeId", selected);
        if (createdJob) query.set("watch", createdJob);
        const data = await api<{ items: GptJob[]; stamp: number }>("/gpt/jobs?" + query, {
          signal: controller.signal,
          timeoutMs: 15000,
        });
        stamp = data.stamp;
        gptCache.stamps[selected || createdJob] = stamp;
        if (disposed) return;
        const completed = data.items.some(
          (job) =>
            job.status === "completed" &&
            previousJobs.current.some((old) => old.id === job.id && isActive(old)),
        );
        setJobs((old) => mergeGptJobs(old, data.items));
        previousJobs.current = mergeGptJobs(previousJobs.current, data.items);
        if (completed) {
          void catalog().catch(() => {});
          if (selectedRef.current && !gptCache.chats[selectedRef.current]?.contextMessage)
            void history(selectedRef.current, undefined, true).catch(() => {});
        }
      } catch {
        /* The composer reports network errors; polling resumes after reconnect. */
      }
      polling = false;
      if (!disposed) timer = setTimeout(poll, document.hidden ? 5000 : 1200);
    };
    void poll();
    const resume = () => {
      if (!document.hidden) void poll();
    };
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("pageshow", resume);
    window.addEventListener("online", resume);
    return () => {
      disposed = true;
      clearTimeout(timer);
      controller.abort();
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("pageshow", resume);
      window.removeEventListener("online", resume);
    };
  }, [catalog, history, selected, createdJob]);
  useEffect(() => {
    Object.assign(gptCache, { jobs, items, projects, models, model, effort, offset });
    saveGptCache();
  }, [jobs, items, projects, models, model, effort, offset]);
  useEffect(() => {
    if (settings) {
      const panel = settingsRef.current;
      if (panel) {
        panel.tabIndex = -1;
        panel.showModal();
        panel.focus({ preventScroll: true });
      }
    } else settingsRef.current?.close();
  }, [settings]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Scroll refs returned by the history hook are stable.
  useEffect(() => {
    if (!messageList.current) return;
    const observer = new ResizeObserver(() => {
      if (sticky.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
    });
    observer.observe(messageList.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      if (document.visibilityState !== "visible") return;
      const request = ++connectionRequest.current;
      try {
        const next = await api<GptConnection>("/gpt/status");
        if (!disposed && request === connectionRequest.current) {
          setConnection(next);
          setReady(next.canSend);
        }
      } catch {
        /* Current drafts remain editable through a transient Hub outage. */
      }
    };
    const interval = setInterval(() => void refresh(), 10000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      disposed = true;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);
  useEffect(() => {
    if (!connection?.canSend || models) return;
    let disposed = false;
    void api<GptModels>("/gpt/models")
      .then((next) => {
        if (disposed) return;
        setModels(next);
        gptCache.models = next;
        setModel((old) => (next.models.some((item) => item.id === old) ? old : next.currentModel));
        setEffort((old) =>
          next.efforts.some((item) => item.id === old) ? old : next.currentEffort,
        );
      })
      .catch(() => {});
    return () => {
      disposed = true;
    };
  }, [connection?.canSend, models]);
  const currentJobs = jobs
    .filter((job) => !job.dismissed)
    .filter((job) => (selected ? job.nativeId === selected : job.id === createdJob))
    .sort((a, b) => a.createdAt - b.createdAt);
  const active = currentJobs.find(isActive);
  // biome-ignore lint/correctness/useExhaustiveDependencies: New content scrolls only while the reader follows the latest reply.
  useLayoutEffect(() => {
    if (sticky.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [messages, currentJobs.map((j) => j.answer + j.status).join("")]);
  const choose = (id: string, jobId = "") => {
    navigationVersion.current++;
    rememberScroll();
    setCreatedJob(jobId);
    setSelected(id);
    setWorkspaceResult("");
    setDrawer(false);
    setView("chat");
    setNotice("");
  };
  useEffect(() => {
    if (!selected && createdJob && jobs.some((job) => job.id === createdJob && job.dismissed)) {
      try {
        sessionStorage.removeItem("gpt-draft-job:" + createdJob);
      } catch {}
      navigationVersion.current++;
      setCreatedJob("");
    }
  }, [selected, createdJob, jobs]);
  const handledWorkspace = useRef(0);
  const [workspaceResult, setWorkspaceResult] = useState("");
  // biome-ignore lint/correctness/useExhaustiveDependencies: A new explicit destination navigates once and never reacquires a writer.
  useEffect(() => {
    if (!workspaceDestination || handledWorkspace.current === workspaceDestination.version) return;
    handledWorkspace.current = workspaceDestination.version;
    const t = workspaceDestination.target;
    const id = t.threadId ?? (t.kind === "thread" ? t.id : "");
    if (id) {
      choose(id);
      if (t.messageId) void history(id, undefined, true, t.messageId).catch(() => {});
      if (t.kind === "result") {
        setWorkspaceResult(t.id);
        setView("results");
        setRightHidden(false);
      }
    } else if (t.kind === "project") {
      setExpanded((old) => new Set([...old, t.id]));
      setDrawer(true);
    }
  }, [workspaceDestination]);
  useEffect(() => {
    if (!contextMessage || loading) return;
    const frame = requestAnimationFrame(() => {
      const target = scroll.current?.querySelector<HTMLElement>(
        `[data-message="${CSS.escape(contextMessage)}"]`,
      );
      target?.scrollIntoView({ block: "center" });
      target?.classList.add("message-focus");
    });
    return () => cancelAnimationFrame(frame);
  }, [contextMessage, loading, scroll]);
  const notebookContext = (): NotebookRequest => {
    const c = items.find((c) => c.id === selected),
      p = projects.find((p) => p.id === c?.projectId);
    return {
      scope: p ? { client: "gpt", projectId: p.id, name: p.name } : null,
      target: selected
        ? {
            client: "gpt",
            kind: "thread",
            id: selected,
            threadId: selected,
            title: c?.title || "Диалог GPT",
            projectId: p?.id,
          }
        : undefined,
    };
  };
  const openNotebook = (mode: "notes" | "tasks" | "plans" | "reports" = "notes") => {
    setDrawer(false);
    setSettings(false);
    onNotebook?.({ ...notebookContext(), mode, allProjects: true });
  };
  const composer = useRef<HTMLTextAreaElement>(null);
  useGrowingComposer(composer, text);
  const send = async (dictated?: string) => {
    const value = dictated ?? text;
    if (
      (dictation.locked && dictated === undefined) ||
      sending.current ||
      uploading ||
      (selected && !historyReady) ||
      !model ||
      (!value.trim() && !files.length)
    )
      return;
    const version = navigationVersion.current,
      sourceDraft = draftScope;
    sending.current = true;
    setBusy(true);
    setNotice("");
    const replaced = selected
      ? undefined
      : currentJobs.find(
          (job) =>
            job.id === createdJob &&
            !job.nativeId &&
            ["failed", "cancelled", "completed"].includes(job.status),
        );
    const body = {
        nativeId: selected || null,
        text: value,
        files: files.map((f) => f.id),
        model,
        effort,
        ...(replaced ? { replacesJobId: replaced.id } : {}),
      },
      signature = JSON.stringify(body);
    const receiptScope = "gpt:" + sourceDraft;
    try {
      const key = pendingSendKey(receiptScope, signature);
      const data = await api<{ job: GptJob }>("/gpt/send", {
        method: "POST",
        body,
        key,
      });
      completePendingSend(receiptScope, key);
      try {
        const key = "gpt-draft-" + sourceDraft;
        const saved = JSON.parse(sessionStorage.getItem(key) ?? "{}");
        if (
          saved.text === body.text &&
          JSON.stringify((saved.files ?? []).map((f: GptFile) => f.id)) ===
            JSON.stringify(body.files)
        ) {
          sessionStorage.removeItem(key);
          clearAcknowledgedSend(receiptScope);
        }
      } catch {}
      if (!selected && navigationVersion.current === version) setCreatedJob(data.job.id);
      setJobs((old) => [
        data.job,
        ...old
          .filter((j) => j.id !== data.job.id)
          .map((job) =>
            job.id === replaced?.id
              ? { ...job, dismissed: true, text: "", files: [], answer: "", assets: [] }
              : job,
          ),
      ]);
      if (navigationVersion.current === version) {
        setText("");
        setFiles([]);
        sticky.current = true;
        if (contextMessage && selected) void history(selected, undefined, true).catch(() => {});
      }
    } catch (e) {
      if (navigationVersion.current === version) setNotice(messageOf(e));
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };
  const attach = async (list: FileList | null) => {
    if (!list) return;
    const sourceDraft = draftScope,
      version = navigationVersion.current;
    setUploading(true);
    setNotice("");
    try {
      if (files.length + list.length > 8) throw Error("До 8 файлов на сообщение.");
      for (const file of Array.from(list)) {
        const data = await api<{ file: GptFile }>(
          "/gpt/uploads?name=" + encodeURIComponent(file.name),
          { method: "POST", raw: file },
        );
        if (navigationVersion.current === version && draftScopeRef.current === sourceDraft)
          setFiles((old) => [...old, data.file]);
        else
          try {
            const key = "gpt-draft-" + sourceDraft,
              draft = JSON.parse(sessionStorage.getItem(key) ?? "{}");
            sessionStorage.setItem(
              key,
              JSON.stringify({ ...draft, files: [...(draft.files ?? []), data.file] }),
            );
          } catch {}
      }
    } catch (e) {
      setNotice(messageOf(e));
    } finally {
      setUploading(false);
      if (input.current) input.current.value = "";
    }
  };

  useNotificationPresence(
    "gpt",
    selected || createdJob,
    view === "chat" &&
      !overviewProject &&
      !drawer &&
      !settings &&
      !machinePanel &&
      !notebookOpen &&
      !contextMessage,
  );
  const handledNotification = useRef("");
  useEffect(() => {
    if (!notificationTarget || handledNotification.current === notificationTarget.id) return;
    handledNotification.current = notificationTarget.id;
    // Persist before consuming the URL; an immediate PWA reload must reopen this target.
    try {
      localStorage.setItem("codex-client", "gpt");
      if (notificationTarget.nativeId)
        localStorage.setItem("gpt-conversation", notificationTarget.nativeId);
      else localStorage.removeItem("gpt-conversation");
      if (!notificationTarget.nativeId && notificationTarget.jobId)
        sessionStorage.setItem("gpt-created-job", notificationTarget.jobId);
      else sessionStorage.removeItem("gpt-created-job");
      onNotificationHandled(notificationTarget.id);
    } catch {
      /* Keep the notification URL when browser storage is unavailable. */
    }
    navigationVersion.current++;
    rememberScroll();
    setCreatedJob(notificationTarget.nativeId ? "" : notificationTarget.jobId || "");
    setSelected(notificationTarget.nativeId || "");
    setDrawer(false);
    setSettings(false);
    setView("chat");
    setNotice("");
  }, [notificationTarget, rememberScroll, onNotificationHandled]);
  const pendingNew = jobs.find((job) => !selected && job.nativeId && job.id === createdJob);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Carry the current draft only when this job acquires its native chat.
  useEffect(() => {
    if (pendingNew?.nativeId) {
      try {
        sessionStorage.setItem("gpt-draft-" + pendingNew.nativeId, JSON.stringify({ text, files }));
      } catch {}
      // Keep the live completion scope through late native identity assignment.
      // Explicit navigation clears createdJob in choose(); reload restores the native id.
      setSelected(pendingNew.nativeId);
    }
  }, [pendingNew?.nativeId]);
  const [resultOverlay, setResultOverlay] = useState(false);
  const speechScope = `gpt:${selected || createdJob}`;
  const dictation = useDictation(
    "gpt:" + draftScope,
    view === "chat" &&
      !overviewProject &&
      !notebookOpen &&
      !settings &&
      !drawer &&
      !machinePanel &&
      !resultOverlay &&
      !busy &&
      (!selected || historyReady),
    text,
    setText,
    100000,
    (text) => send(text),
  );
  useSpeechScope(
    speechScope,
    view === "chat" &&
      !overviewProject &&
      !notebookOpen &&
      !settings &&
      !drawer &&
      !machinePanel &&
      !resultOverlay,
  );
  const [resultCategory, setResultCategory] = useState<ResultCategory>("all");
  const [resultFocusVersion, setResultFocusVersion] = useState(0);
  const openResults = (category: ResultCategory = "all") => {
    setResultCategory(category);
    setResultFocusVersion((v) => v + 1);
    setRightHidden(false);
    setView("results");
  };
  const completionLocked = useCompletionPosition({
    scope: createdJob || selected,
    enabled:
      view === "chat" &&
      !drawer &&
      !settings &&
      !overviewProject &&
      !notebookOpen &&
      !machinePanel &&
      !contextMessage &&
      !hasNewer,
    following: sticky,
    scroller: scroll,
    content: messageList,
    entries: currentJobs.map((job) => {
      const matchingUsers = messages
        .map((m, index) => ({ m, index }))
        .filter(
          ({ m }) =>
            m.role === "user" &&
            m.text === job.text &&
            m.createdAt * 1000 >= job.createdAt - 30000 &&
            m.createdAt * 1000 <= job.updatedAt,
        );
      const user = matchingUsers.length === 1 ? matchingUsers[0]!.index : -1;
      const subsequent = user >= 0 ? messages.slice(user + 1) : [];
      const nextUser = subsequent.findIndex((m) => m.role === "user");
      const answer = (nextUser >= 0 ? subsequent.slice(0, nextUser) : subsequent).findLast(
        (m) => m.role === "assistant",
      );
      return {
        id: job.id,
        active: job.status === "preparing" || job.status === "running",
        complete: job.status === "completed",
        target: answer?.id ?? "job:" + job.id,
      };
    }),
  });
  const jobElements = currentJobs
    .filter((job) =>
      showGptJob(
        job,
        messages,
        Date.now(),
        currentJobs,
        !historyReady || historyStale || !!historyNotice,
      ),
    )
    .map((job) => {
      const nativeUser = messages.some(
        (m) =>
          m.role === "user" && m.text === job.text && m.createdAt * 1000 >= job.createdAt - 30000,
      );
      return (
        <section className="gpt-job" key={job.id}>
          {!nativeUser && (
            <article className="message user">
              <div className="message-header">
                <span className="avatar">Я</span>
                <b>Вы</b>
                <small>{titles[job.status]}</small>
                <CopyButton text={job.text} />
              </div>
              <div className="message-body">
                <Text value={job.text} />
                <Files files={job.files} />
              </div>
            </article>
          )}
          {(job.answer || job.assets.length > 0) && (
            <article className="message assistant" data-message={"job:" + job.id}>
              <div className="message-header">
                <span className="avatar">G</span>
                <b>GPT</b>
                <span className="message-actions">
                  <SpeechButton id={`${speechScope}:job-${job.id}`} text={job.answer} />
                  <CopyButton text={job.answer} />
                </span>
              </div>
              <div className="message-body">
                {!isActive(job) && !!job.progress?.length && <GptProgress items={job.progress} />}
                <Text value={job.answer} />
                <ResponseResults text={job.answer} files={job.assets} onOpen={openResults} />
              </div>
            </article>
          )}
          {job.error && (
            <div className="gpt-job-error" role="status">
              <p>{job.error}</p>
              {job.status === "unknown" ? (
                <button
                  type="button"
                  onClick={() =>
                    void action(async () => {
                      if (job.nativeId) await history(job.nativeId, undefined, true);
                      await api("/gpt/jobs/" + job.id + "/resolve", { method: "POST" });
                    })
                  }
                >
                  Проверено
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    if (job.nativeId && job.nativeId !== selected) {
                      try {
                        sessionStorage.setItem(
                          "gpt-draft-" + job.nativeId,
                          JSON.stringify({ text: job.text, files: job.files }),
                        );
                      } catch {}
                      setSelected(job.nativeId);
                    } else {
                      setText(job.text);
                      setFiles(job.files);
                    }
                  }}
                >
                  Вернуть в черновик
                </button>
              )}
            </div>
          )}
          {job.status === "queued" && (
            <button
              type="button"
              onClick={() =>
                void action(async () => {
                  await api("/gpt/jobs/" + job.id + "/cancel", { method: "POST" });
                })
              }
            >
              Убрать из очереди
            </button>
          )}
        </section>
      );
    });
  useEffect(() => {
    const current = items.find((t) => t.id === selected);
    if (
      current &&
      (current.deleted ||
        current.archived ||
        projects.some((p) => p.id === current.projectId && (p.deleted || p.archived)))
    )
      setSelected("");
    for (const row of items.filter(
      (t) => t.deleted || projects.some((p) => p.id === t.projectId && p.deleted),
    )) {
      delete gptCache.chats[row.id];
      beginGptHistory(row.id);
    }
  }, [items, projects, selected]);
  const navThread = (item: GptConversation) => {
    const running = jobs.some((job) => job.nativeId === item.id && isActive(job));
    return (
      <div className={"entity-row " + (selected === item.id ? "selected" : "")} key={item.id}>
        <button
          className={"nav-thread " + (selected === item.id ? "selected" : "")}
          type="button"
          onClick={() => choose(item.id)}
        >
          <Icon name={item.pinned ? "pin" : "chat"} size={17} />
          <span>{item.title}</span>
          {running && <span className="spinner" />}
        </button>
        <EntityMenu
          client="gpt"
          entity={{
            id: item.id,
            kind: "thread",
            name: item.title,
            projectId: item.projectId,
            pinned: item.pinned,
          }}
          active={running}
        />
      </div>
    );
  };
  const filtered = items
    .filter(
      (item) =>
        !item.archived &&
        !item.deleted &&
        !projects.some((p) => p.id === item.projectId && (p.archived || p.deleted)) &&
        item.title.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
    )
    .sort(
      (a, b) =>
        Number(jobs.some((j) => j.nativeId === b.id && isActive(j))) -
          Number(jobs.some((j) => j.nativeId === a.id && isActive(j))) ||
        Number(!!b.pinned) - Number(!!a.pinned) ||
        b.updatedAt - a.updatedAt,
    );
  const threadActive = (item: GptConversation) =>
    jobs.some((job) => job.nativeId === item.id && isActive(job));
  const outboxNavigation = jobs
    .filter(
      (job) =>
        !job.dismissed &&
        !job.nativeId &&
        (job.status !== "cancelled" || !!job.answer || job.assets.length > 0),
    )
    .filter((job) => !search || job.text.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
    .map((job) => (
      <div className="entity-row" key={job.id}>
        <button
          type="button"
          className={"nav-thread" + (!selected && createdJob === job.id ? " selected" : "")}
          onClick={() => choose("", job.id)}
        >
          <Icon name="chat" />
          <span>
            {job.text.slice(0, 60) || "Новая отправка"}
            <small>{titles[job.status]}</small>
          </span>
          {isActive(job) && <span className="spinner" aria-hidden="true" />}
        </button>
        <EntityMenu
          client="gpt"
          outbox
          entity={{ id: job.id, kind: "thread", name: job.text.slice(0, 120) || "Отправка" }}
          active={isActive(job) || job.status === "unknown"}
          onDone={() => {
            setJobs((old) =>
              old.map((item) =>
                item.id === job.id
                  ? { ...item, dismissed: true, text: "", files: [], answer: "", assets: [] }
                  : item,
              ),
            );
            try {
              sessionStorage.removeItem("gpt-draft-job:" + job.id);
            } catch {}
            if (!selected && createdJob === job.id) choose("");
          }}
        />
      </div>
    ));
  const navigation = (
    <div className="navigation-inner">
      <div className="navigation-top-row">
        <div className="nav-search">
          <button
            type="button"
            className="icon-button"
            aria-label="Поиск по содержимому"
            title="Поиск по содержимому"
            onClick={() =>
              openContentSearch({ client: "gpt", threadId: selected || undefined, query: search })
            }
          >
            <Icon name="search" size={18} />
          </button>
          <input
            aria-label="Найти чат GPT"
            placeholder="Найти…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <button
          type="button"
          className="icon-button mobile-only panel-close"
          aria-label="Закрыть проекты"
          data-drawer-close
          onClick={() => setDrawer(false)}
        >
          <Icon name="close" />
        </button>
      </div>
      <div className="gpt-nav-list">
        <PinnedList
          activeBeforePinned={false}
          items={projects
            .filter((p) => !p.archived && !p.deleted)
            .sort(
              (a, b) =>
                Number(
                  jobs.some(
                    (j) =>
                      isActive(j) && items.some((t) => t.id === j.nativeId && t.projectId === b.id),
                  ),
                ) -
                  Number(
                    jobs.some(
                      (j) =>
                        isActive(j) &&
                        items.some((t) => t.id === j.nativeId && t.projectId === a.id),
                    ),
                  ) ||
                Number(!!b.pinned) - Number(!!a.pinned) ||
                Math.max(0, ...items.filter((t) => t.projectId === b.id).map((t) => t.updatedAt)) -
                  Math.max(0, ...items.filter((t) => t.projectId === a.id).map((t) => t.updatedAt)),
            )}
          storageKey="gpt-projects"
          recent={(p) =>
            items.reduce(
              (last, t) => (t.projectId === p.id ? Math.max(last, t.updatedAt) : last),
              0,
            )
          }
          searching={!!search.trim()}
          active={(p) => items.some((t) => t.projectId === p.id && threadActive(t))}
          renderItem={(project) => (
            <section key={project.id}>
              <div className="entity-row">
                <button
                  type="button"
                  className="nav-thread"
                  aria-expanded={expanded.has(project.id)}
                  onClick={() =>
                    setExpanded((old) => {
                      const next = new Set(old);
                      if (next.has(project.id)) next.delete(project.id);
                      else next.add(project.id);
                      return next;
                    })
                  }
                >
                  <Icon name={project.pinned ? "pin" : "folder"} />
                  <span>{project.name}</span>
                  <span className="project-chevron" data-open={expanded.has(project.id)}>
                    <Icon name="chevron" size={15} />
                  </span>
                </button>
                <EntityMenu
                  client="gpt"
                  entity={{
                    id: project.id,
                    kind: "project",
                    name: project.name,
                    pinned: project.pinned,
                  }}
                  active={jobs.some(
                    (j) =>
                      isActive(j) &&
                      items.some((t) => t.id === j.nativeId && t.projectId === project.id),
                  )}
                />
              </div>
              {expanded.has(project.id) && (
                <button
                  type="button"
                  className="nav-new-thread overview-nav"
                  onClick={() => {
                    setOverviewProject(project);

                    setDrawer(false);
                  }}
                >
                  <Icon name="folder" size={16} />
                  Обзор проекта
                </button>
              )}
              {expanded.has(project.id) && (
                <PinnedList
                  activeBeforePinned={false}
                  items={filtered.filter((c) => c.projectId === project.id)}
                  renderItem={navThread}
                  active={threadActive}
                  recent={(t) => t.updatedAt}
                  storageKey={"gpt-project-" + project.id}
                  searching={!!search.trim()}
                />
              )}
            </section>
          )}
        />
        <div className="nav-label">
          <span>Диалоги</span>
          <button
            type="button"
            className="icon-button"
            aria-label="Новый чат GPT"
            onClick={() => choose("")}
          >
            <Icon name="plus" />
          </button>
        </div>
        <PinnedList
          activeBeforePinned={false}
          items={filtered.filter((c) => !projects.some((p) => p.id === c.projectId))}
          renderItem={navThread}
          active={threadActive}
          recent={(t) => t.updatedAt}
          unpinnedPrefix={outboxNavigation}
          storageKey="gpt-threads"
          searching={!!search.trim()}
        />
        {offset !== null && (
          <button
            type="button"
            className="nav-new-thread"
            onClick={() => void action(() => catalog(true, offset))}
          >
            Загрузить ещё
          </button>
        )}
      </div>
      {onNotebook && (
        <WorkspaceLinks
          onTasks={() => openNotebook("tasks")}
          onNotes={() => openNotebook()}
          onPlans={() => openNotebook("plans")}
          onReports={() => openNotebook("reports")}
        />
      )}

      <NavigationFooter
        client="gpt"
        captureScope={(() => {
          const p = projects.find((p) => p.id === items.find((t) => t.id === selected)?.projectId);
          return p ? { client: "gpt" as const, projectId: p.id, name: p.name } : null;
        })()}
        onClient={() => {
          setDrawer(false);
          onCodex();
        }}
        onSettings={() => {
          setDrawer(false);
          setSettings(true);
        }}
        remoteHref="/gpt-connect?immersive=1"
      />
    </div>
  );
  const selectedItem = items.find((item) => item.id === selected);
  const selectedProject = projects.find((project) => project.id === selectedItem?.projectId);
  const selectedTitle = selectedItem?.title || (selected ? "Разговор GPT" : "Новый чат");
  const resultExtras: ResultItem[] = currentJobs
    .filter((job) =>
      showGptJob(
        job,
        messages,
        Date.now(),
        currentJobs,
        !historyReady || historyStale || !!historyNotice,
      ),
    )
    .flatMap((job) =>
      job.assets.map((file) => ({
        id: file.id,
        turnId: null,
        type: file.image ? "image" : "file",
        title: file.name,
        createdAt: new Date(job.updatedAt).toISOString(),
        payload: { url: file.url, mime: file.mime },
      })),
    );
  return (
    <div
      className={"workspace gpt-workspace " + (navCollapsed ? "nav-collapsed" : "")}
      data-view={view}
      data-right-hidden={rightHidden}
      ref={root}
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
          disabled={!selectedProject}
          aria-label="Обзор проекта"
          onClick={() => selectedProject && setOverviewProject(selectedProject)}
        >
          <span>
            <Icon name="chat" size={17} />
            {selectedProject?.name ?? "GPT"}
          </span>
          <small>{selectedTitle}</small>
        </button>
        {active && <span className="spinner" role="img" aria-label="GPT работает" />}
        <button
          type="button"
          className="icon-button wide-pane-control"
          aria-label={rightHidden ? "Показать правую панель" : "Скрыть правую панель"}
          aria-expanded={!rightHidden}
          onClick={() => setRightHidden((v) => !v)}
        >
          <Icon name="panel-right" />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Новый чат GPT"
          onClick={() => choose("")}
        >
          <Icon name="plus" />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Документы Canvas"
          disabled={!selected}
          onClick={() => setCanvasOpen(true)}
        >
          <Icon name="file" />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Настройки"
          onClick={() => setSettings(true)}
        >
          <Icon name="settings" />
        </button>
      </header>
      {(notice || loadNotice) && (
        <div className="global-notice" role="status">
          <span>{notice || loadNotice}</span>
          <button
            type="button"
            className="icon-button"
            aria-label="Закрыть уведомление"
            onClick={() => {
              setNotice("");
              setLoadNotice("");
            }}
          >
            <Icon name="close" />
          </button>
        </div>
      )}
      {canvasOpen && selected && (
        <CanvasPanel
          key={selected}
          conversationId={selected}
          onClose={() => setCanvasOpen(false)}
        />
      )}
      <main className="workspace-content">
        {overviewProject && (
          <ProjectOverviewModal
            key={overviewProject.id}
            onClose={() => setOverviewProject(null)}
            scope={{ client: "gpt", projectId: overviewProject.id, name: overviewProject.name }}
            cachedThreads={items
              .filter((t) => t.projectId === overviewProject.id && !t.archived && !t.deleted)
              .sort(
                (a, b) =>
                  Number(threadActive(b)) - Number(threadActive(a)) || b.updatedAt - a.updatedAt,
              )
              .slice(0, 4)
              .map((t) => ({
                id: t.id,
                title: t.title,
                active: threadActive(t),
                unread: false,
                status: threadActive(t) ? "running" : "idle",
                updatedAt: new Date(t.updatedAt * 1000).toISOString(),
              }))}
            onNotebook={(r) => onNotebook?.(r)}
            onTarget={(t) => {
              if (
                t.kind === "note" ||
                t.kind === "task" ||
                t.kind === "plan" ||
                t.kind === "report"
              ) {
                onNotebook?.({
                  scope: {
                    client: "gpt",
                    projectId: overviewProject.id,
                    name: overviewProject.name,
                  },
                  mode:
                    t.kind === "task"
                      ? "tasks"
                      : t.kind === "plan"
                        ? "plans"
                        : t.kind === "report"
                          ? "reports"
                          : "notes",
                  itemId: t.id,
                });
                return;
              }
              if (t.client === "codex") {
                if (onWorkspaceTarget) onWorkspaceTarget(t);
                else if (t.projectId) onCodexProject?.(t.projectId, false);
                return;
              }
              const id = t.threadId ?? t.id;
              choose(id);
              if (t.kind === "result") {
                setWorkspaceResult(t.id);
                setView("results");
                setRightHidden(false);
              }
            }}
          />
        )}
        <section className="gpt-chat" hidden={view !== "chat"}>
          {historyReady && historyNotice && (
            <div className="gpt-revalidating" role="status" aria-label="Обновление истории">
              {historyNotice}
            </div>
          )}
          <div
            className="gpt-message-scroll"
            ref={scroll}
            onWheel={() => {
              userScrollUntil.current = performance.now() + 1500;
            }}
            onTouchMove={() => {
              userScrollUntil.current = performance.now() + 1500;
            }}
            onPointerDown={() => {
              userScrollUntil.current = performance.now() + 1500;
            }}
            onScroll={() => {
              if (scroll.current && performance.now() < userScrollUntil.current) {
                if (!completionLocked.current)
                  sticky.current =
                    scroll.current.scrollHeight -
                      scroll.current.scrollTop -
                      scroll.current.clientHeight <
                    120;
                rememberScroll();
              }
            }}
          >
            <div ref={messageList}>
              {(contextMessage || hasNewer) && (
                <div className="history-context">
                  <span>Фрагмент диалога</span>
                  <button
                    type="button"
                    onClick={() => void history(selected, undefined, true).catch(() => {})}
                  >
                    К последним сообщениям
                  </button>
                </div>
              )}
              {before && (
                <button
                  type="button"
                  className="history-more"
                  disabled={loading}
                  onClick={() => {
                    sticky.current = false;
                    void history(selected, before).catch(() => {});
                  }}
                >
                  Загрузить ещё 20
                </button>
              )}
              {selected && !historyReady && (
                <div
                  className="gpt-history-state"
                  role="status"
                  aria-label="Состояние выбранного чата"
                >
                  <Icon name="chat" size={32} />
                  <h2>{selectedTitle}</h2>
                  {historyNotice ? (
                    <>
                      <p>{historyNotice}</p>
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => void history(selected, undefined, true).catch(() => {})}
                      >
                        <Icon name="refresh" />
                        Повторить загрузку
                      </button>
                    </>
                  ) : (
                    <p>
                      <span className="spinner" />
                      Загружаем разговор…
                    </p>
                  )}
                </div>
              )}
              {selected && historyReady && revalidating && !historyNotice && (
                <div className="gpt-revalidating" role="status">
                  <span className="spinner" />
                  Обновляем разговор…
                </div>
              )}
              {!selected && !messages.length && !currentJobs.length && (
                <div className="gpt-empty">Что обсудим?</div>
              )}
              {messages.map((message) => (
                <article
                  className={"message " + message.role}
                  key={message.id}
                  data-message={message.id}
                >
                  <div className="message-header">
                    <span className="avatar">{message.role === "user" ? "Я" : "G"}</span>
                    <b>{message.role === "user" ? "Вы" : "GPT"}</b>
                    <span className="message-actions">
                      {nativeOperations.button(message, !!active || busy)}
                      {message.role === "assistant" && (
                        <SpeechButton id={`${speechScope}:${message.id}`} text={message.text} />
                      )}
                      {onNotebook && message.text.trim() && (
                        <button
                          type="button"
                          className="icon-button"
                          aria-label="Сохранить в заметки"
                          onClick={() => {
                            const context = notebookContext();
                            onNotebook({
                              ...context,
                              mode: "notes",
                              capture: {
                                scope: context.scope,
                                text: message.text,
                                role: message.role,
                                target: {
                                  client: "gpt",
                                  kind: "thread",
                                  id: selected,
                                  threadId: selected,
                                  messageId: message.id,
                                  title: items.find((c) => c.id === selected)?.title || "Чат GPT",
                                },
                              },
                            });
                          }}
                        >
                          <Icon name="file" size={17} />
                        </button>
                      )}
                      <CopyButton text={message.text} />
                    </span>
                  </div>
                  <div className="message-body">
                    {message.role === "assistant" &&
                      currentJobs
                        .filter(
                          (job) =>
                            !isActive(job) &&
                            job.progress?.length &&
                            messages.some(
                              (m) =>
                                m.role === "user" &&
                                m.text === job.text &&
                                m.createdAt * 1000 >= job.createdAt - 30000,
                            ) &&
                            messages.findIndex((m) => m.id === message.id) ===
                              messages.findIndex(
                                (m) =>
                                  m.role === "user" &&
                                  m.text === job.text &&
                                  m.createdAt * 1000 >= job.createdAt - 30000,
                              ) +
                                1,
                        )
                        .map((job) => <GptProgress key={job.id} items={job.progress ?? []} />)}
                    <Text value={message.text} />
                    {!!message.unsupported?.length && (
                      <aside className="native-content-notice">
                        <p>
                          {message.unsupported
                            .map(
                              (kind) =>
                                ({
                                  audio: "Аудио",
                                  video: "Видео",
                                  interactive: "Интерактивное содержимое",
                                  other: "Дополнительное содержимое",
                                })[kind],
                            )
                            .join(" · ")}{" "}
                          доступно в оригинале.
                        </p>
                        <a
                          href={`https://chatgpt.com/c/${encodeURIComponent(selected)}`}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          Открыть этот диалог в ChatGPT
                        </a>
                      </aside>
                    )}
                    {message.role === "user" ? (
                      <Files files={message.files} />
                    ) : (
                      <ResponseResults
                        text={message.text}
                        files={message.files}
                        onOpen={openResults}
                      />
                    )}
                  </div>
                  {reviews
                    .filter((r) => r.source?.messageId === message.id)
                    .map((r) => (
                      <WorkReviewLink key={r.id} scope={r.scope} id={r.id} state={r.state} />
                    ))}
                </article>
              ))}
              {jobElements}
              {reviews
                .filter(
                  (r) =>
                    !r.source?.messageId || !messages.some((m) => m.id === r.source?.messageId),
                )
                .map((r) => (
                  <WorkReviewLink key={r.id} scope={r.scope} id={r.id} state={r.state} />
                ))}
            </div>
          </div>
          <div className="gpt-composer-wrap">
            {nativeOperations.panel}
            <GptProjectPending />
            {connection && !connection.canSend && (
              <div className="gpt-connection-notice" role="status">
                <span>{connection.message}</span>
                {["login_required", "attention"].includes(connection.state) ? (
                  <a className="secondary" href="/gpt-connect">
                    {connection.state === "attention" ? "Открыть" : "Войти"}
                  </a>
                ) : (
                  <button
                    type="button"
                    className="icon-button"
                    aria-label="Проверить подключение GPT"
                    disabled={checkingConnection}
                    onClick={() => void checkConnection()}
                  >
                    <Icon name="refresh" />
                  </button>
                )}
              </div>
            )}
            {active && (
              <GptProgress
                key={active.id}
                items={active.progress ?? []}
                running
                label={titles[active.status]}
                onStop={() =>
                  void action(async () => {
                    await api("/gpt/jobs/" + active.id + "/cancel", { method: "POST" });
                  })
                }
              />
            )}
            {dictation.panel}
            <form
              className="composer gpt-composer"
              hidden={!!selected && !historyReady}
              onSubmit={(event) => {
                event.preventDefault();
                void send();
              }}
            >
              <div className="gpt-options">
                <label className="composer-option">
                  <span>{models?.models.find((m) => m.id === model)?.label ?? "Модель"}</span>
                  <select
                    aria-label="Модель GPT"
                    value={model}
                    disabled={!models}
                    onChange={(event) => setModel(event.target.value)}
                  >
                    {models?.models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="composer-option effort-option">
                  <span>{models?.efforts.find((e) => e.id === effort)?.label ?? "Мощность"}</span>
                  <select
                    aria-label="Мощность GPT"
                    value={effort}
                    disabled={!models}
                    onChange={(event) => setEffort(event.target.value)}
                  >
                    {models?.efforts.map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {files.length > 0 && (
                <div className="gpt-upload-list">
                  {files.map((file) => (
                    <div key={file.id}>
                      {file.image && <img src={file.url} alt="" />}
                      <span>{file.name}</span>
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={"Убрать " + file.name}
                        onClick={() => setFiles((old) => old.filter((f) => f.id !== file.id))}
                      >
                        <Icon name="close" size={16} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <div className="gpt-input-row">
                <button
                  type="button"
                  className="icon-button"
                  disabled={uploading}
                  aria-label="Добавить файлы"
                  onClick={() => input.current?.click()}
                >
                  {uploading ? <span className="spinner" /> : <Icon name="plus" />}
                </button>
                <textarea
                  ref={composer}
                  aria-label="Сообщение GPT"
                  placeholder="Что нужно сделать?"
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                  rows={2}
                />
                <div className="composer-submit">
                  {dictation.button}
                  <button
                    type="submit"
                    className="send-button"
                    disabled={
                      nativeOperations.blocked ||
                      dictation.locked ||
                      busy ||
                      uploading ||
                      !ready ||
                      (!!selected && !historyReady) ||
                      !model ||
                      (!text.trim() && !files.length)
                    }
                    aria-label={active ? "Добавить в очередь GPT" : "Отправить GPT"}
                  >
                    {busy ? <span className="spinner" /> : <Icon name="arrow-up" />}
                  </button>
                </div>
              </div>
              <input
                ref={input}
                type="file"
                multiple
                hidden
                onChange={(event) => void attach(event.target.files)}
              />
            </form>
          </div>
        </section>
        <div className="support-pane gpt-results">
          <ResultFeed
            focusId={workspaceResult}
            onSaveLink={
              selected
                ? (r) =>
                    onNotebook?.({
                      ...notebookContext(),
                      target: {
                        client: "gpt",
                        kind: "result",
                        id: r.id,
                        title: r.title,
                        threadId: selected,
                        turnId: r.turnId ?? undefined,
                      },
                    })
                : undefined
            }
            key={selected || createdJob}
            endpoint={
              selected ? "/gpt/conversations/" + encodeURIComponent(selected) + "/results" : ""
            }
            revision={
              messages.map((m) => m.id + ":" + m.text.length).join(",") +
              ":" +
              currentJobs.map((j) => j.updatedAt).join(",")
            }
            visible={view === "results" || view === "chat"}
            onOverlayChange={setResultOverlay}
            focusCategory={resultCategory}
            focusVersion={resultFocusVersion}
            extras={resultExtras}
          />
        </div>
      </main>
      <nav className="mobile-tabs">
        <button
          type="button"
          className={view === "chat" ? "active" : ""}
          onClick={() => setView("chat")}
        >
          <Icon name="chat" />
          <span>Чат</span>
        </button>
        <button
          type="button"
          className={view === "results" ? "active" : ""}
          onClick={() => {
            setRightHidden(false);
            setView("results");
          }}
        >
          <Icon name="results" />
          <span>Результаты</span>
        </button>
      </nav>
      <dialog
        className="project-sheet"
        aria-label="Проекты и диалоги"
        ref={drawerRef}
        onCancel={(event) => {
          event.preventDefault();
          setDrawer(false);
        }}
      >
        <div className="sheet-content">{navigation}</div>
      </dialog>
      <dialog
        className="gpt-settings settings-browser"
        aria-label="Настройки"
        ref={settingsRef}
        onCancel={() => setSettings(false)}
      >
        <SettingsSections
          open={settings}
          client="GPT"
          onClose={() => setSettings(false)}
          sections={{
            appearance: () => <AppearanceSettings theme={theme} onTheme={onTheme} />,
            sound: (visible) => (
              <>
                <SpeechSettings />
                <Notifications visible={visible} />
              </>
            ),
            connections: () => (
              <>
                <section className="gpt-connection-settings" aria-label="Состояние GPT">
                  <p role="status">{connection?.message ?? "Проверяем подключение GPT…"}</p>
                  <button
                    type="button"
                    className="secondary"
                    disabled={checkingConnection}
                    onClick={() => void checkConnection()}
                  >
                    <Icon name="refresh" />
                    {checkingConnection ? "Проверяем…" : "Перепроверить подключение"}
                  </button>
                  <a className="primary" href="/gpt-connect">
                    {connection?.state === "login_required"
                      ? "Войти в ChatGPT"
                      : "Подключение ChatGPT"}
                  </a>
                </section>
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
              </>
            ),
            library: () => (
              <section className="settings-navigation-actions" aria-label="Навигация">
                <button type="button" onClick={() => void action(() => catalog())}>
                  <Icon name="refresh" />
                  Обновить чаты
                </button>
                <EntityArchive client="gpt" />
              </section>
            ),
            maintenance: (visible) => (
              <>
                <DeploymentStatus open={visible} />
                <BridgeDoctorPanel
                  open={visible}
                  onTarget={
                    onWorkspaceTarget
                      ? (target) => {
                          setSettings(false);
                          onWorkspaceTarget(target);
                        }
                      : undefined
                  }
                />
                <StorageUsage visible={visible} />
              </>
            ),
            access: () => <AccountControls onSession={onSession} onLogout={onLogout} />,
          }}
        />
      </dialog>
      <MachineHealthPanel
        open={machinePanel}
        onClose={() => setMachinePanel(false)}
        onProject={(id, remote) => {
          setMachinePanel(false);
          if (onCodexProject) onCodexProject(id, remote);
          else onCodex();
        }}
      />
    </div>
  );
}
