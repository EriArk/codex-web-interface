import type {
  GptConnection,
  GptConversation,
  GptFile,
  GptJob,
  GptModels,
  GptProject,
  ResultCategory,
  ResultItem,
} from "@codex-web/shared";
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import { AccountControls } from "./AccountControls";
import { api, messageOf } from "./api";
import { ClientPicker } from "./ClientPicker";
import { CollapsibleCode } from "./CollapsibleCode";
import { CopyButton } from "./CopyButton";
import {
  EntityArchive,
  EntityMenu,
  type LibraryChange,
  type LibraryEntity,
  libraryEvent,
} from "./EntityMenu";
import { GptProgress } from "./GptProgress";
import { beginGptHistory, gptCache, saveGptCache } from "./gptCache";
import { mergeGptJobs, showGptJob } from "./gptState";
import { Icon } from "./icons";
import { ResultFeed } from "./ResultFeed";
import { type Theme, themes } from "./theme";
import type { Session } from "./types";
import { useGptHistory } from "./useGptHistory";
import { useProjectDrawer } from "./useProjectDrawer";
import { useProjectSwipe } from "./useProjectSwipe";
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
        <a key={file.id} href={file.url} target="_blank" rel="noopener noreferrer">
          {file.image ? (
            <img src={file.url} alt={file.name} loading="lazy" />
          ) : (
            <>
              <Icon name="file" />
              <span>{file.name}</span>
            </>
          )}
        </a>
      ))}
    </div>
  );
});
const Text = memo(function Text({ value }: { value: string }) {
  return (
    <Markdown
      components={{
        pre: CollapsibleCode,
        a: (props) => <a {...props} target="_blank" rel="noopener noreferrer" />,
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
  onCodex,
  theme,
  onTheme,
  onSession,
  onLogout,
}: {
  onCodex: () => void;
  theme: Theme;
  onTheme: (theme: Theme) => void;
  onSession: (session: Session) => void;
  onLogout: () => void;
}) {
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
  const [createdJob, setCreatedJob] = useState("");
  const [selected, setSelected] = useState(cachedId);
  const [jobs, setJobs] = useState<GptJob[]>(gptCache.jobs),
    [models, setModels] = useState<GptModels | null>(gptCache.models),
    [model, setModel] = useState(gptCache.model),
    [effort, setEffort] = useState(gptCache.effort);
  const [text, setText] = useState(""),
    [files, setFiles] = useState<GptFile[]>([]),
    [busy, setBusy] = useState(false),
    [uploading, setUploading] = useState(false);
  const [notice, setNotice] = useState(""),
    [drawer, setDrawer] = useState(false),
    [settings, setSettings] = useState(false),
    [view, setView] = useState<"chat" | "results">("chat");
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
    sendKey = useRef<{ signature: string; key: string } | null>(null),
    sending = useRef(false),
    draftLoaded = useRef("");
  const previousJobs = useRef<GptJob[]>(gptCache.jobs);
  const { messages, before, loading, scroll, sticky, history, rememberScroll } = useGptHistory(
    selected,
    setNotice,
  );
  selectedRef.current = selected;
  useProjectSwipe(root, !drawer && !settings, () => setDrawer(true));
  const action = useCallback(async (fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      setNotice(messageOf(e));
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
    let disposed = false;
    void action(async () => {
      const request = ++connectionRequest.current;
      const status = await api<GptConnection>("/gpt/status");
      if (disposed) return;
      if (request === connectionRequest.current) {
        setConnection(status);
        setReady(status.canSend);
      }
      if (!status.configured) {
        setNotice("Подключение GPT ещё не настроено.");
        return;
      }
      await catalog(false, 0, false);
      const result = gptCache.models ?? (await api<GptModels>("/gpt/models"));
      if (disposed) return;
      setModels(result);
      setModel((old) => old || result.currentModel);
      setEffort((old) => old || result.currentEffort);
    });
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
    };
  }, [catalog, action]);
  useEffect(() => {
    try {
      if (selected) localStorage.setItem("gpt-conversation", selected);
      else localStorage.removeItem("gpt-conversation");
      const draft = JSON.parse(sessionStorage.getItem("gpt-draft-" + selected) ?? "{}");
      setText(typeof draft.text === "string" ? draft.text : "");
      setFiles(Array.isArray(draft.files) ? draft.files : []);
    } catch {
      setText("");
      setFiles([]);
    }
    draftLoaded.current = selected;
    sendKey.current = null;
  }, [selected]);
  useEffect(() => {
    if (draftLoaded.current === selected)
      try {
        sessionStorage.setItem("gpt-draft-" + selected, JSON.stringify({ text, files }));
      } catch {
        /* Optional draft cache. */
      }
  }, [selected, text, files]);
  useEffect(() => {
    let disposed = false,
      timer: ReturnType<typeof setTimeout>;
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
        const data = await api<{ items: GptJob[]; stamp: number }>("/gpt/jobs?" + query);
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
          if (selectedRef.current)
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
    return () => {
      disposed = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [catalog, history, selected, createdJob]);
  useEffect(() => {
    Object.assign(gptCache, { jobs, items, projects, models, model, effort, offset });
    saveGptCache();
  }, [jobs, items, projects, models, model, effort, offset]);
  useEffect(() => {
    if (settings) settingsRef.current?.showModal();
    else settingsRef.current?.close();
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
    .filter((job) => (selected ? job.nativeId === selected : job.nativeId === null))
    .sort((a, b) => a.createdAt - b.createdAt);
  const active = currentJobs.find(isActive);
  // biome-ignore lint/correctness/useExhaustiveDependencies: New content scrolls only while the reader follows the latest reply.
  useLayoutEffect(() => {
    if (sticky.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [messages, currentJobs.map((j) => j.answer + j.status).join("")]);
  const choose = (id: string) => {
    rememberScroll();
    setCreatedJob("");
    setSelected(id);
    setDrawer(false);
    setView("chat");
    setNotice("");
  };
  const send = async () => {
    if (sending.current || uploading || !model || (!text.trim() && !files.length)) return;
    sending.current = true;
    setBusy(true);
    setNotice("");
    const body = { nativeId: selected || null, text, files: files.map((f) => f.id), model, effort },
      signature = JSON.stringify(body);
    if (sendKey.current?.signature !== signature)
      sendKey.current = { signature, key: crypto.randomUUID() };
    try {
      const data = await api<{ job: GptJob }>("/gpt/send", {
        method: "POST",
        body,
        key: sendKey.current.key,
      });
      if (!selected && selectedRef.current === selected) setCreatedJob(data.job.id);
      setJobs((old) => [data.job, ...old.filter((j) => j.id !== data.job.id)]);
      if (selectedRef.current === selected) {
        setText("");
        setFiles([]);
        sendKey.current = null;
        sticky.current = true;
      } else
        try {
          sessionStorage.removeItem("gpt-draft-" + selected);
        } catch {}
    } catch (e) {
      setNotice(messageOf(e));
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };
  const attach = async (list: FileList | null) => {
    if (!list) return;
    setUploading(true);
    setNotice("");
    try {
      if (files.length + list.length > 8) throw Error("До 8 файлов на сообщение.");
      for (const file of Array.from(list)) {
        const data = await api<{ file: GptFile }>(
          "/gpt/uploads?name=" + encodeURIComponent(file.name),
          { method: "POST", raw: file },
        );
        if (selectedRef.current === selected) setFiles((old) => [...old, data.file]);
        else
          try {
            const key = "gpt-draft-" + selected,
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
  const pendingNew = jobs.find((job) => !selected && job.nativeId && job.id === createdJob);
  useEffect(() => {
    if (pendingNew?.nativeId) {
      setCreatedJob("");
      setSelected(pendingNew.nativeId);
    }
  }, [pendingNew?.nativeId]);
  const [, setResultOverlay] = useState(false);
  const [resultCategory, setResultCategory] = useState<ResultCategory>("all");
  const [resultFocusVersion, setResultFocusVersion] = useState(0);
  const openResults = (category: ResultCategory = "all") => {
    setResultCategory(category);
    setResultFocusVersion((v) => v + 1);
    setRightHidden(false);
    setView("results");
  };
  const jobElements = currentJobs
    .filter((job) => showGptJob(job, messages))
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
            <article className="message assistant">
              <div className="message-header">
                <span className="avatar">G</span>
                <b>GPT</b>
                <CopyButton text={job.answer} />
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
  const navigation = (
    <div className="navigation-inner">
      <div className="nav-brand">
        <img src="/icon.svg" width="32" height="32" alt="" />
        <span>
          <ClientPicker
            value="gpt"
            onChange={(value) => {
              if (value === "codex") {
                setDrawer(false);
                onCodex();
              }
            }}
          />
        </span>
        <button
          type="button"
          className="icon-button mobile-only"
          aria-label="Закрыть проекты"
          data-drawer-close
          onClick={() => setDrawer(false)}
        >
          <Icon name="close" />
        </button>
      </div>
      <div className="nav-search">
        <Icon name="search" size={16} />
        <input
          aria-label="Найти чат GPT"
          placeholder="Найти…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>
      <div className="gpt-nav-list">
        {projects
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
                      isActive(j) && items.some((t) => t.id === j.nativeId && t.projectId === a.id),
                  ),
                ) || Number(!!b.pinned) - Number(!!a.pinned),
          )
          .map((project) => (
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
              {expanded.has(project.id) &&
                filtered.filter((c) => c.projectId === project.id).map(navThread)}
            </section>
          ))}
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
        {filtered.filter((c) => !projects.some((p) => p.id === c.projectId)).map(navThread)}
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
      <button type="button" className="nav-new-thread" onClick={() => void action(() => catalog())}>
        <Icon name="refresh" />
        Обновить
      </button>
      <EntityArchive client="gpt" />
      <a className="nav-new-thread" href="/gpt-connect">
        <Icon name="remote" />
        Открыть ChatGPT
      </a>
      <button
        type="button"
        className="nav-new-thread"
        onClick={() => {
          setDrawer(false);
          setSettings(true);
        }}
      >
        <Icon name="settings" />
        Настройки
      </button>
    </div>
  );
  const resultExtras: ResultItem[] = currentJobs
    .filter((job) => showGptJob(job, messages))
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
        <div className="header-project">
          <span>
            <Icon name="chat" size={17} />
            GPT
          </span>
          <small>{items.find((item) => item.id === selected)?.title ?? "Новый чат"}</small>
        </div>
        {active && <span className="spinner" role="img" aria-label="GPT работает" />}
        <a href="/gpt-connect" className="icon-button" aria-label="Открыть ChatGPT">
          <Icon name="remote" />
        </a>
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
          aria-label="Настройки"
          onClick={() => setSettings(true)}
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
            aria-label="Закрыть уведомление"
            onClick={() => setNotice("")}
          >
            <Icon name="close" />
          </button>
        </div>
      )}
      <main className="workspace-content">
        <section className="gpt-chat" hidden={view !== "chat"}>
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
              {before && (
                <button
                  type="button"
                  className="history-more"
                  disabled={loading}
                  onClick={() => {
                    sticky.current = false;
                    void action(() => history(selected, before));
                  }}
                >
                  Загрузить ещё 20
                </button>
              )}
              {loading && !messages.length && (
                <span className="spinner" role="img" aria-label="Загрузка истории" />
              )}
              {!loading && !messages.length && !currentJobs.length && (
                <div className="gpt-empty">Что обсудим?</div>
              )}
              {messages.map((message) => (
                <article className={"message " + message.role} key={message.id}>
                  <div className="message-header">
                    <span className="avatar">{message.role === "user" ? "Я" : "G"}</span>
                    <b>{message.role === "user" ? "Вы" : "GPT"}</b>
                    <CopyButton text={message.text} />
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
                </article>
              ))}
              {jobElements}
            </div>
          </div>
          <div className="gpt-composer-wrap">
            {connection && !connection.canSend && (
              <div className="gpt-connection-notice" role="status">
                <span>{connection.message}</span>
                {connection.state === "login_required" ? (
                  <a className="secondary" href="/gpt-connect">
                    Войти
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
            <form
              className="gpt-composer"
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
                  aria-label="Сообщение GPT"
                  placeholder="Что нужно сделать?"
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                  rows={2}
                />
                <button
                  type="submit"
                  className="primary icon-button"
                  disabled={
                    busy || uploading || !ready || !model || (!text.trim() && !files.length)
                  }
                  aria-label={active ? "Добавить в очередь GPT" : "Отправить GPT"}
                >
                  {busy ? <span className="spinner" /> : <Icon name="arrow-up" />}
                </button>
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
        <a href="/gpt-connect">
          <Icon name="remote" />
          <span>ChatGPT</span>
        </a>
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
      <dialog className="gpt-settings" ref={settingsRef} onCancel={() => setSettings(false)}>
        <div className="gpt-settings-heading">
          <h2>Настройки</h2>
          <button
            type="button"
            className="icon-button"
            aria-label="Закрыть настройки"
            onClick={() => setSettings(false)}
          >
            <Icon name="close" />
          </button>
        </div>
        <div className="gpt-themes">
          {themes.map((item) => (
            <button
              type="button"
              key={item.id}
              className={theme === item.id ? "selected" : ""}
              onClick={() => onTheme(item.id)}
            >
              {item.title}
            </button>
          ))}
        </div>
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
            {connection?.state === "login_required" ? "Войти в ChatGPT" : "Подключение ChatGPT"}
          </a>
        </section>
        <AccountControls onSession={onSession} onLogout={onLogout} />
      </dialog>
    </div>
  );
}
