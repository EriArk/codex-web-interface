import {
  compareActivity,
  compareThreadActivity,
  hasUnreadCompletion,
  type NavigationState,
  type ProjectActivity,
  type ThreadActivity,
} from "@codex-web/shared";
import { useEffect, useState } from "react";
import { ActivityBadge } from "./ActivityBadge";
import { Icon } from "./icons";
import type { Project, Thread } from "./types";

export function ProjectNavigation({
  projects,
  activity,
  activityConnected,
  threadGroups,
  projectId,
  threadId,
  busy,
  loading,
  machine,
  onExpand,
  onThread,
  onNewThread,
  onNewProject,
  onRefresh,
  onClose,
  onSettings,
}: {
  projects: Project[];
  activity: NavigationState;
  activityConnected: boolean;
  threadGroups: Record<string, Thread[]>;
  projectId: string;
  threadId: string;
  busy: boolean;
  loading: boolean;
  machine: string;
  onExpand: (id: string) => Promise<void>;
  onThread: (id: string, projectId: string) => void;
  onNewThread: (projectId: string) => void;
  onNewProject: () => void;
  onRefresh: () => void;
  onClose: () => void;
  onSettings: () => void;
}) {
  const [section, setSection] = useState<"projects" | "threads">("projects");
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const selected = projects.find((p) => p.id === projectId);
  const projectActivity = new Map(activity.projects.map((p) => [p.id, p]));
  const threadActivity = new Map(activity.threads.map((t) => [t.id, t]));
  const summary = (p: Project): ProjectActivity =>
    projectActivity.get(p.id) ?? {
      id: p.id,
      active: 0,
      unread: 0,
      waiting: 0,
      updatedAt: "",
      activityAt: "",
    };
  const detail = (t: Thread): ThreadActivity =>
    threadActivity.get(t.id) ?? {
      ...t,
      updatedAt: "",
      activityAt: null,
      completedSeq: 0,
      seenSeq: 0,
      completedTurnId: null,
      completedStatus: null,
    };
  const groups = { ...threadGroups };
  for (const p of projects) {
    const list = new Map((groups[p.id] ?? []).map((t) => [t.id, t]));
    for (const t of activity.threads)
      if (t.projectId === p.id) list.set(t.id, { ...list.get(t.id), ...t });
    if (list.size)
      groups[p.id] = [...list.values()].sort((a, b) => compareThreadActivity(detail(a), detail(b)));
  }
  const folders = projects
    .filter((p) => !p.unassigned)
    .sort((a, b) => compareActivity(summary(a), summary(b)));
  const standalone = projects.filter((p) => p.unassigned);
  const matches = (text: string) =>
    text.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  const load = async (id: string) => {
    setPending((old) => new Set(old).add(id));
    setErrors((old) => ({ ...old, [id]: "" }));
    try {
      await onExpand(id);
    } catch {
      setErrors((old) => ({ ...old, [id]: "Не удалось обновить диалоги." }));
    } finally {
      setPending((old) => {
        const next = new Set(old);
        next.delete(id);
        return next;
      });
    }
  };
  useEffect(() => {
    if (projectId) setExpanded((old) => new Set(old).add(projectId));
  }, [projectId]);
  const renderThread = (t: Thread) => {
    const status = detail(t);
    const active = ["running", "starting", "waiting_approval"].includes(status.status);
    return (
      <button
        type="button"
        className={`nav-thread ${threadId === t.id ? "selected" : ""}`}
        key={t.id}
        disabled={busy}
        onClick={() => onThread(t.id, t.projectId)}
        aria-current={threadId === t.id ? "page" : undefined}
        data-thread-id={t.id}
      >
        <Icon name="chat" size={17} />
        <span>{t.title}</span>
        <ActivityBadge
          active={Number(active)}
          waiting={Number(status.status === "waiting_approval")}
          unread={Number(hasUnreadCompletion(status))}
          failed={status.completedStatus !== "completed"}
        />
      </button>
    );
  };
  const threadList = (p: Project) => {
    const list = groups[p.id];
    return (
      <section className="project-thread-list" aria-label={`Диалоги: ${p.name}`}>
        {pending.has(p.id) && !list && (
          <p className="nav-empty" role="status">
            Загружаем диалоги…
          </p>
        )}
        {errors[p.id] && (
          <button type="button" className="nav-empty" onClick={() => void load(p.id)}>
            {errors[p.id]} Повторить
          </button>
        )}
        {list?.filter((t) => matches(p.name) || matches(t.title)).map(renderThread)}
        {list?.length === 0 && !pending.has(p.id) && (
          <p className="nav-empty">
            {p.unassigned ? "Пока нет чатов без проекта." : "В проекте пока нет диалогов."}
          </p>
        )}
        <button
          type="button"
          className="nav-new-thread"
          disabled={busy}
          onClick={() => onNewThread(p.id)}
        >
          <Icon name="plus" size={16} />
          Новый диалог
        </button>
      </section>
    );
  };
  return (
    <div className="navigation-inner" data-section={section}>
      <div className="nav-brand">
        <img src="/icon.svg" width="32" height="32" alt="" />
        <span>
          codex<small className="brand-subtitle">Личное пространство</small>
        </span>
        <button
          type="button"
          className="icon-button mobile-only"
          aria-label="Закрыть проекты"
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </div>
      <nav className="nav-mobile-switch" aria-label="Навигация по проектам">
        <button
          type="button"
          className={section === "projects" ? "selected" : ""}
          onClick={() => {
            setSection("projects");
            setQuery("");
          }}
        >
          <span className="nav-tab-title">
            Проекты <small>{folders.length}</small>
          </span>
          <ActivityBadge
            counts
            active={folders.filter((p) => summary(p).active > 0).length}
            waiting={
              folders.filter(
                (p) => summary(p).active > 0 && summary(p).active === summary(p).waiting,
              ).length
            }
            unread={folders.filter((p) => summary(p).unread > 0).length}
          />
        </button>
        <button
          type="button"
          className={section === "threads" ? "selected" : ""}
          onClick={() => {
            setSection("threads");
            setQuery("");
            for (const p of standalone) void load(p.id);
          }}
        >
          <span className="nav-tab-title">
            Диалоги{" "}
            <small>
              {standalone.reduce((sum, p) => sum + (groups[p.id]?.length ?? p.threadCount ?? 0), 0)}
            </small>
          </span>
          <ActivityBadge
            counts
            active={standalone.reduce((sum, p) => sum + summary(p).active, 0)}
            waiting={standalone.reduce((sum, p) => sum + summary(p).waiting, 0)}
            unread={standalone.reduce((sum, p) => sum + summary(p).unread, 0)}
          />
        </button>
      </nav>
      <div className="nav-search">
        <Icon name="search" size={16} />
        <input
          aria-label="Поиск проектов и диалогов"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Найти…"
          type="search"
        />
      </div>
      {!activityConnected && (
        <p className="nav-sync-state" role="status">
          Обновляем состояние…
        </p>
      )}
      {activity.warnings?.map((w) => (
        <p className="nav-sync-state" role="status" key={w}>
          {w}
        </p>
      ))}
      <div className="nav-scroll">
        <section className="nav-projects">
          <div className="nav-label">
            Проекты{" "}
            <span className="nav-label-actions">
              <button
                type="button"
                className="icon-button"
                aria-label="Обновить проекты"
                disabled={loading}
                onClick={onRefresh}
              >
                <Icon name="refresh" size={16} />
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label="Создать проект"
                disabled={busy}
                onClick={onNewProject}
              >
                <Icon name="plus" size={18} />
              </button>
            </span>
          </div>
          {loading && !folders.length && (
            <p className="nav-empty" role="status">
              Подключаем твои проекты…
            </p>
          )}
          {folders
            .filter((p) => matches(p.name) || groups[p.id]?.some((t) => matches(t.title)))
            .map((p) => {
              const open = expanded.has(p.id) || !!query.trim();
              return (
                <div className="nav-project-group" key={p.id}>
                  <button
                    type="button"
                    className={`nav-project ${projectId === p.id ? "selected" : ""}`}
                    disabled={busy}
                    aria-expanded={open}
                    data-project-id={p.id}
                    onClick={() => {
                      setExpanded((old) => {
                        const next = new Set(old);
                        if (next.has(p.id)) next.delete(p.id);
                        else next.add(p.id);
                        return next;
                      });
                      if (!open) void load(p.id);
                    }}
                  >
                    <span
                      className={`folder-icon folder-${projects.findIndex((item) => item.id === p.id) % 5}`}
                    >
                      <Icon name="folder" />
                    </span>
                    <span>
                      {p.name}
                      <small>{p.machineName}</small>
                    </span>
                    <ActivityBadge
                      active={summary(p).active}
                      unread={summary(p).unread}
                      waiting={summary(p).waiting}
                    />
                    <span className="project-chevron" data-open={open}>
                      <Icon name="chevron" size={15} />
                    </span>
                  </button>
                  {open && threadList(p)}
                </div>
              );
            })}
          {query &&
            !folders.some(
              (p) => matches(p.name) || groups[p.id]?.some((t) => matches(t.title)),
            ) && <p className="nav-empty">Ничего не найдено</p>}
          <button type="button" className="nav-add-project" onClick={onNewProject} disabled={busy}>
            <Icon name="plus" size={16} />
            Новый проект
          </button>
        </section>
        <section className="nav-threads">
          <div className="nav-label">Без проекта</div>
          <p className="nav-section-help">
            Отдельные чаты. Диалоги проектов раскрываются во вкладке «Проекты».
          </p>
          <section className="standalone-thread-list" aria-label="Диалоги без проекта">
            {standalone
              .flatMap((p) => groups[p.id] ?? [])
              .filter((t) => matches(t.title))
              .sort((a, b) => compareThreadActivity(detail(a), detail(b)))
              .map(renderThread)}
            {standalone.map((p) => (
              <button
                key={p.id}
                type="button"
                className="nav-new-thread"
                disabled={busy}
                onClick={() => onNewThread(p.id)}
              >
                <Icon name="plus" size={16} />
                Новый диалог{standalone.length > 1 ? ` · ${p.machineName}` : ""}
              </button>
            ))}
          </section>
          {!standalone.length && <p className="nav-empty">Чатов без проекта пока нет.</p>}
        </section>
      </div>
      <div className="nav-bottom">
        <div className="machine-indicator">
          <span className={`status-dot ${machine}`} />
          <span>
            {selected?.machineName ?? "Компьютер"}
            <small>
              {machine === "online"
                ? "На связи"
                : machine === "offline"
                  ? "Нет соединения"
                  : "Проверяем соединение"}
            </small>
          </span>
        </div>
        <button type="button" className="nav-settings" onClick={onSettings}>
          <Icon name="settings" size={18} />
          Настройки
        </button>
      </div>
    </div>
  );
}
