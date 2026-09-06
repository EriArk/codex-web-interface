import type {
  GptConversation,
  GptFile,
  GptJob,
  GptMessage,
  GptModels,
  GptProject,
} from "@codex-web/shared";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import { api, messageOf } from "./api";
import { ClientPicker } from "./ClientPicker";
import { CollapsibleCode } from "./CollapsibleCode";
import { showGptJob } from "./gptState";
import { Icon } from "./icons";
import { type Theme, themes } from "./theme";
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
function Files({ files }: { files: GptFile[] }) {
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
}
function Text({ value }: { value: string }) {
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
}: {
  onCodex: () => void;
  theme: Theme;
  onTheme: (theme: Theme) => void;
}) {
  const [items, setItems] = useState<GptConversation[]>([]),
    [projects, setProjects] = useState<GptProject[]>([]),
    [offset, setOffset] = useState<number | null>(null);
  const [createdJob, setCreatedJob] = useState("");
  const [selected, setSelected] = useState(cachedId),
    [messages, setMessages] = useState<GptMessage[]>([]),
    [before, setBefore] = useState<string | null>(null);
  const [jobs, setJobs] = useState<GptJob[]>([]),
    [models, setModels] = useState<GptModels | null>(null),
    [model, setModel] = useState(""),
    [effort, setEffort] = useState("");
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
    [loading, setLoading] = useState(false),
    [rightHidden, setRightHidden] = useState(false);
  const [navCollapsed, setNavCollapsed] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const root = useRef<HTMLDivElement>(null),
    drawerRef = useRef<HTMLDialogElement>(null),
    settingsRef = useRef<HTMLDialogElement>(null),
    scroll = useRef<HTMLDivElement>(null),
    input = useRef<HTMLInputElement>(null),
    messageList = useRef<HTMLDivElement>(null),
    userScrollUntil = useRef(0);
  const selectedRef = useRef(selected),
    request = useRef(0),
    sendKey = useRef<{ signature: string; key: string } | null>(null),
    sending = useRef(false),
    draftLoaded = useRef("");
  const sticky = useRef(true),
    previousJobs = useRef<GptJob[]>([]);
  selectedRef.current = selected;
  useProjectSwipe(root, !drawer && !settings, () => setDrawer(true));
  const action = useCallback(async (fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      setNotice(messageOf(e));
    }
  }, []);
  const catalog = useCallback(async (append = false, next = 0) => {
    const data = await api<{ items: GptConversation[]; nextOffset: number | null }>(
      "/gpt/conversations?offset=" + next,
    );
    setItems((old) =>
      append
        ? [...new Map([...old, ...data.items].map((c) => [c.id, c])).values()]
        : [
            ...new Map(
              [...old.filter((c) => c.projectId), ...data.items].map((c) => [c.id, c]),
            ).values(),
          ],
    );
    setOffset(data.nextOffset);
  }, []);
  const history = useCallback(async (id: string, older?: string) => {
    if (!id) return;
    const generation = ++request.current;
    setLoading(true);
    try {
      const data = await api<{ items: GptMessage[]; nextBefore: string | null }>(
        "/gpt/conversations/" +
          encodeURIComponent(id) +
          "/messages" +
          (older ? "?before=" + encodeURIComponent(older) : ""),
      );
      if (generation !== request.current || selectedRef.current !== id) return;
      const oldHeight = scroll.current?.scrollHeight ?? 0;
      setMessages((old) =>
        older ? [...new Map([...data.items, ...old].map((m) => [m.id, m])).values()] : data.items,
      );
      setBefore(data.nextBefore);
      if (older)
        requestAnimationFrame(() => {
          if (scroll.current) scroll.current.scrollTop += scroll.current.scrollHeight - oldHeight;
        });
    } finally {
      if (generation === request.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    let disposed = false;
    void action(async () => {
      const status = await api<{ configured: boolean }>("/gpt/status");
      if (disposed) return;
      setReady(status.configured);
      if (!status.configured) {
        setNotice("Подключение GPT ещё не настроено.");
        return;
      }
      await catalog();
      const result = await api<GptModels>("/gpt/models");
      if (disposed) return;
      setModels(result);
      setModel(result.currentModel);
      setEffort(result.currentEffort);
    });
    void api<{ items: GptProject[]; conversations: GptConversation[] }>("/gpt/projects")
      .then((data) => {
        if (!disposed) {
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
    ++request.current;
    setMessages([]);
    setBefore(null);
    sticky.current = true;
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
    if (selected) void history(selected).catch((e) => setNotice(messageOf(e)));
  }, [selected, history]);
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
      stamp = 0;
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
        if (disposed) return;
        const completed = data.items.some(
          (job) =>
            job.status === "completed" &&
            previousJobs.current.some((old) => old.id === job.id && isActive(old)),
        );
        setJobs((old) =>
          [...new Map([...old, ...data.items].map((job) => [job.id, job])).values()].slice(-100),
        );
        previousJobs.current = [
          ...new Map([...previousJobs.current, ...data.items].map((job) => [job.id, job])).values(),
        ].slice(-100);
        if (completed) {
          void catalog().catch(() => {});
          if (selectedRef.current) void history(selectedRef.current).catch(() => {});
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
    if (drawer) drawerRef.current?.showModal();
    else drawerRef.current?.close();
  }, [drawer]);
  useEffect(() => {
    if (settings) settingsRef.current?.showModal();
    else settingsRef.current?.close();
  }, [settings]);
  useEffect(() => {
    if (!messageList.current) return;
    const observer = new ResizeObserver(() => {
      if (sticky.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
    });
    observer.observe(messageList.current);
    return () => observer.disconnect();
  }, []);
  const currentJobs = jobs
    .filter((job) => (selected ? job.nativeId === selected : job.nativeId === null))
    .sort((a, b) => a.createdAt - b.createdAt);
  const active = currentJobs.find(isActive);
  // biome-ignore lint/correctness/useExhaustiveDependencies: New content scrolls only while the reader follows the latest reply.
  useLayoutEffect(() => {
    if (sticky.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [messages, currentJobs.map((j) => j.answer + j.status).join("")]);
  const choose = (id: string) => {
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
              </div>
              <div className="message-body">
                <Text value={job.answer} />
                <Files files={job.assets} />
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
                      if (job.nativeId) await history(job.nativeId);
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
  const navThread = (item: GptConversation) => {
    const running = jobs.some((job) => job.nativeId === item.id && isActive(job));
    return (
      <button
        className={"nav-thread " + (selected === item.id ? "selected" : "")}
        type="button"
        key={item.id}
        onClick={() => choose(item.id)}
      >
        <Icon name="chat" size={17} />
        <span>{item.title}</span>
        {running && <span className="spinner" />}
      </button>
    );
  };
  const filtered = items
    .filter((item) => item.title.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
    .sort(
      (a, b) =>
        Number(jobs.some((j) => j.nativeId === b.id && isActive(j))) -
          Number(jobs.some((j) => j.nativeId === a.id && isActive(j))) || b.updatedAt - a.updatedAt,
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
          <small className="brand-subtitle">Личное пространство</small>
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
        {projects.map((project) => (
          <section key={project.id}>
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
              <Icon name="folder" />
              <span>{project.name}</span>
              <Icon name="chevron" />
            </button>
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
  const resultFiles = [
    ...new Map(
      [
        ...messages.flatMap((m) => (m.role === "assistant" ? m.files : [])),
        ...currentJobs.flatMap((j) => j.assets),
      ].map((file) => [file.id, file]),
    ).values(),
  ];
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
          <span>GPT</span>
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
              if (scroll.current && performance.now() < userScrollUntil.current)
                sticky.current =
                  scroll.current.scrollHeight -
                    scroll.current.scrollTop -
                    scroll.current.clientHeight <
                  120;
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
                  </div>
                  <div className="message-body">
                    <Text value={message.text} />
                    <Files files={message.files} />
                  </div>
                </article>
              ))}
              {jobElements}
            </div>
          </div>
          <div className="gpt-composer-wrap">
            {active && (
              <div className="gpt-progress" role="status">
                <span className="spinner" />
                <span>{titles[active.status]}</span>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Остановить GPT"
                  onClick={() =>
                    void action(async () => {
                      await api("/gpt/jobs/" + active.id + "/cancel", { method: "POST" });
                    })
                  }
                >
                  <Icon name="stop" />
                </button>
              </div>
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
          <div className="support-tabs">
            <button type="button" className="active">
              Результаты
            </button>
          </div>
          <div className="gpt-result-scroll">
            <Files files={resultFiles} />
            {!resultFiles.length && (
              <p className="gpt-empty">Здесь появятся изображения и файлы.</p>
            )}
          </div>
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
      <dialog className="project-sheet" ref={drawerRef} onCancel={() => setDrawer(false)}>
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
        <a className="primary" href="/gpt-connect">
          Подключение ChatGPT
        </a>
      </dialog>
    </div>
  );
}
