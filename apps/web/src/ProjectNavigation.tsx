import {
  compareActivity,
  compareThreadActivity,
  hasUnreadCompletion,
  type NavigationState,
  type ProjectActivity,
  type ThreadActivity,
} from "@codex-web/shared";
import { useEffect, useRef, useState } from "react";
import { ActivityBadge } from "./ActivityBadge";
import { SpaceBell, SpaceCards, SpaceModeControl } from "./CollaborationSpaces";
import { EntityMenu } from "./EntityMenu";
import { Icon } from "./icons";
import { NavigationFooter } from "./NavigationFooter";
import { NavigationHeader } from "./NavigationHeader";
import { PinnedList } from "./PinnedList";
import type { Project, Thread } from "./types";
import type { SpacesController } from "./useCollaborationSpaces";
import { WorkspaceLinks } from "./WorkspaceLinks";

export function ProjectNavigation({
  spaces,
  projects,
  activity,
  threadGroups,
  projectId,
  threadId,
  busy,
  loading,
  onExpand,
  onThread,
  onNewThread,
  onNewProject,
  onClose,
  onSettings,
  onNotebook,
  onPlans,
  onReports,
  onPlan,
  onOverview,
  onClient,
  onRemote,
}: {
  spaces: SpacesController;
  projects: Project[];
  activity: NavigationState;
  threadGroups: Record<string, Thread[]>;
  projectId: string;
  threadId: string;
  busy: boolean;
  loading: boolean;
  machine: string;
  onExpand: (id: string) => Promise<Thread[] | void>;
  onThread: (id: string, projectId: string) => void;
  onNewThread: (projectId: string) => void;
  onNewProject: () => void;
  onRefresh: () => void;
  onClose: () => void;
  onSettings: () => void;
  onNotebook?: () => void;
  onPlans?: () => void;
  onReports?: () => void;
  onPlan?: () => void;
  onOverview?: (id: string) => void;
  onClient?: (value: "codex" | "gpt") => void;
  onRemote?: () => void;
}) {
  const openRequest = useRef(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Mode changes invalidate outstanding navigation requests.
  useEffect(() => {
    // A delayed project expansion must not select its chat in the other mode.
    ++openRequest.current;
  }, [spaces.mode]);
  const [section, setSection] = useState<"projects" | "threads">("projects");
  const [sharedSection, setSharedSection] = useState<"spaces" | "brainstorm">("spaces");
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const metadata = new Map((activity.library ?? []).map((e) => [e.kind + e.id, e]));
  projects = projects.map((p) => ({ ...p, ...metadata.get("project" + p.id) }));
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
    const list = new Map(
      (groups[p.id] ?? [])
        .filter(
          (t) =>
            !metadata.get("thread" + t.id)?.archived && !metadata.get("thread" + t.id)?.deleted,
        )
        .map((t) => [
          t.id,
          {
            ...t,
            pinned: metadata.has("thread" + t.id)
              ? metadata.get("thread" + t.id)?.pinned === true
              : t.pinned,
          },
        ]),
    );
    for (const t of activity.threads)
      if (
        t.projectId === p.id &&
        !metadata.get("thread" + t.id)?.archived &&
        !metadata.get("thread" + t.id)?.deleted
      )
        list.set(t.id, {
          ...list.get(t.id),
          ...t,
          pinned: metadata.has("thread" + t.id)
            ? metadata.get("thread" + t.id)?.pinned === true
            : list.get(t.id)?.pinned,
        });
    groups[p.id] = [...list.values()].sort(
      (a, b) =>
        Number(["running", "starting", "waiting_approval"].includes(detail(b).status)) -
          Number(["running", "starting", "waiting_approval"].includes(detail(a).status)) ||
        Number(!!b.pinned) - Number(!!a.pinned) ||
        compareThreadActivity(detail(a), detail(b)),
    );
  }
  const spaceMode = spaces.enabled && spaces.mode === "spaces";
  const selectedSpace = spaces.catalog.spaces.find((s) => s.id === spaces.selectedId);
  const sharedIds = new Set(
    spaces.catalog.spaces.flatMap((s) => s.projects.map((p) => p.personalProjectId)),
  );
  const selectedIds = new Set(selectedSpace?.projects.map((p) => p.personalProjectId));
  const folders = projects
    .filter(
      (p) =>
        !p.unassigned &&
        !p.archived &&
        !p.deleted &&
        (spaceMode ? selectedIds.has(p.id) : !sharedIds.has(p.id)),
    )
    .sort(
      (a, b) =>
        Number(summary(b).active > 0) - Number(summary(a).active > 0) ||
        Number(!!b.pinned) - Number(!!a.pinned) ||
        compareActivity(summary(a), summary(b)),
    );
  const standalone = projects.filter((p) => p.unassigned);
  const matches = (text: string) =>
    text.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  const load = async (id: string) => {
    setPending((old) => new Set(old).add(id));
    setErrors((old) => ({ ...old, [id]: "" }));
    try {
      return await onExpand(id);
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: A newer navigation invalidates an in-flight folder click.
  useEffect(
    () => () => {
      ++openRequest.current;
    },
    [projectId, threadId],
  );
  useEffect(() => {
    if (projectId) setExpanded((old) => new Set(old).add(projectId));
  }, [projectId]);
  const renderThread = (t: Thread) => {
    const status = detail(t);
    const active = ["running", "starting", "waiting_approval"].includes(status.status);
    return (
      <div className={"entity-row " + (threadId === t.id ? "selected" : "")} key={t.id}>
        <button
          type="button"
          className={`nav-thread ${threadId === t.id ? "selected" : ""}`}
          disabled={busy}
          onClick={() => {
            ++openRequest.current;
            onThread(t.id, t.projectId);
          }}
          aria-current={threadId === t.id ? "page" : undefined}
          data-thread-id={t.id}
        >
          <Icon name={t.pinned ? "pin" : "chat"} size={17} />
          <span>{t.title}</span>
          <ActivityBadge
            active={Number(active)}
            waiting={Number(status.status === "waiting_approval")}
            unread={Number(hasUnreadCompletion(status))}
            failed={status.completedStatus !== "completed"}
          />
        </button>
        <EntityMenu
          client="codex"
          entity={{
            id: t.id,
            kind: "thread",
            name: t.title,
            projectId: t.projectId,
            pinned: t.pinned,
          }}
          active={active}
        />
      </div>
    );
  };
  const threadActive = (t: Thread) =>
    ["running", "starting", "waiting_approval"].includes(detail(t).status);
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
        <PinnedList
          items={(list ?? []).filter((t) => matches(p.name) || matches(t.title))}
          renderItem={renderThread}
          active={threadActive}
          recent={(t) => Date.parse(detail(t).activityAt || detail(t).updatedAt) || 0}
          storageKey={"codex-project-" + p.id}
          searching={!!query.trim()}
        />
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
    <div className="navigation-inner" data-section={spaceMode ? "projects" : section}>
      <NavigationHeader leading={<SpaceModeControl spaces={spaces} />} onClose={onClose}>
        {spaceMode ? (
          <nav className="nav-mobile-switch" aria-label="Общая работа">
            <button
              type="button"
              className={sharedSection === "spaces" ? "selected" : ""}
              onClick={() => setSharedSection("spaces")}
            >
              <span className="nav-tab-title">Пространства</span>
            </button>
            <button
              type="button"
              className={sharedSection === "brainstorm" ? "selected" : ""}
              onClick={() => setSharedSection("brainstorm")}
            >
              <span className="nav-tab-title">Брейншторм</span>
            </button>
          </nav>
        ) : (
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
                  {standalone.reduce(
                    (sum, p) => sum + (groups[p.id]?.length ?? p.threadCount ?? 0),
                    0,
                  )}
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
        )}
      </NavigationHeader>
      <div className="nav-scroll">
        {spaceMode && sharedSection === "spaces" && <SpaceCards spaces={spaces} query={query} />}
        {spaceMode && sharedSection === "brainstorm" && (
          <p className="nav-empty">Здесь появятся комнаты для совместного обсуждения идей.</p>
        )}
        {(!spaceMode || (selectedSpace && sharedSection === "spaces")) && (
          <section className="nav-projects">
            <div className="nav-label">
              {spaceMode ? "Мои рабочие проекты" : "Проекты"}{" "}
              {!spaceMode && (
                <span className="nav-label-actions">
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
              )}
            </div>
            {loading && !folders.length && (
              <p className="nav-empty" role="status">
                Подключаем твои проекты…
              </p>
            )}
            <PinnedList
              items={folders.filter(
                (p) => matches(p.name) || groups[p.id]?.some((t) => matches(t.title)),
              )}
              active={(p) => summary(p).active > 0}
              recent={(p) => Date.parse(summary(p).activityAt || summary(p).updatedAt) || 0}
              storageKey="codex-projects"
              searching={!!query.trim()}
              renderItem={(p) => {
                const list = groups[p.id] ?? [];
                const single = list.length === 1 || (list.length === 0 && p.threadCount === 1);
                const open = !single && (expanded.has(p.id) || !!query.trim());
                return (
                  <div className="nav-project-group" key={p.id}>
                    <div className={"entity-row " + (projectId === p.id ? "selected" : "")}>
                      <button
                        type="button"
                        className={`nav-project ${projectId === p.id ? "selected" : ""}`}
                        disabled={busy || pending.has(p.id)}
                        aria-expanded={single ? undefined : open}
                        data-project-id={p.id}
                        onClick={(event) => {
                          const request = ++openRequest.current;
                          const button = event.currentTarget;
                          const sole = list.length === 1 ? list[0] : undefined;
                          if (sole) {
                            onThread(sole.id, p.id);
                            return;
                          }
                          setExpanded((old) => {
                            const next = new Set(old);
                            if (next.has(p.id) && !single) next.delete(p.id);
                            else next.add(p.id);
                            return next;
                          });
                          if (!open)
                            void load(p.id).then((loaded) => {
                              if (
                                request !== openRequest.current ||
                                !button.isConnected ||
                                !button.getClientRects().length
                              )
                                return;
                              const visible = loaded?.filter(
                                (t) =>
                                  !metadata.get("thread" + t.id)?.archived &&
                                  !metadata.get("thread" + t.id)?.deleted,
                              );
                              if (visible?.length === 1 && visible[0])
                                onThread(visible[0].id, p.id);
                            });
                        }}
                      >
                        <span
                          className={`folder-icon folder-${projects.findIndex((item) => item.id === p.id) % 5}`}
                        >
                          <Icon name={p.pinned ? "pin" : "folder"} />
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
                        {pending.has(p.id) ? (
                          <span className="spinner" role="img" aria-label="Загрузка диалогов" />
                        ) : (
                          !single && (
                            <span className="project-chevron" data-open={open}>
                              <Icon name="chevron" size={15} />
                            </span>
                          )
                        )}
                      </button>
                      <EntityMenu
                        client="codex"
                        entity={{ id: p.id, kind: "project", name: p.name, pinned: p.pinned }}
                        active={summary(p).active > 0}
                        relatedThread={
                          list.length === 1 && list[0]
                            ? {
                                id: list[0].id,
                                kind: "thread",
                                name: list[0].title,
                                projectId: p.id,
                                pinned: list[0].pinned,
                              }
                            : undefined
                        }
                        newThreadDisabled={busy}
                        onNewThread={() => {
                          ++openRequest.current;
                          setExpanded((old) => new Set(old).add(p.id));
                          onNewThread(p.id);
                        }}
                      />
                    </div>
                    {single && errors[p.id] && (
                      <button type="button" className="nav-empty" onClick={() => void load(p.id)}>
                        {errors[p.id]} Повторить
                      </button>
                    )}
                    {open && onOverview && (
                      <button
                        type="button"
                        className="nav-new-thread overview-nav"
                        onClick={() => {
                          ++openRequest.current;
                          onOverview(p.id);
                        }}
                      >
                        <Icon name="folder" size={16} />
                        Обзор проекта
                      </button>
                    )}
                    {open && threadList(p)}
                  </div>
                );
              }}
            />
            {query &&
              !folders.some(
                (p) => matches(p.name) || groups[p.id]?.some((t) => matches(t.title)),
              ) && <p className="nav-empty">Ничего не найдено</p>}
            {!spaceMode && (
              <button
                type="button"
                className="nav-add-project"
                onClick={onNewProject}
                disabled={busy}
              >
                <Icon name="plus" size={16} />
                Новый проект
              </button>
            )}
          </section>
        )}
        {!spaceMode && (
          <section className="nav-threads">
            <div className="nav-label">Без проекта</div>
            <section className="standalone-thread-list" aria-label="Диалоги без проекта">
              <PinnedList
                items={standalone
                  .flatMap((p) => groups[p.id] ?? [])
                  .filter((t) => matches(t.title))
                  .sort(
                    (a, b) =>
                      Number(
                        ["running", "starting", "waiting_approval"].includes(detail(b).status),
                      ) -
                        Number(
                          ["running", "starting", "waiting_approval"].includes(detail(a).status),
                        ) ||
                      Number(!!b.pinned) - Number(!!a.pinned) ||
                      compareThreadActivity(detail(a), detail(b)),
                  )}
                renderItem={renderThread}
                active={threadActive}
                recent={(t) => Date.parse(detail(t).activityAt || detail(t).updatedAt) || 0}
                storageKey="codex-threads"
                searching={!!query.trim()}
              />
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
        )}
      </div>
      <div className="nav-bottom">
        <WorkspaceLinks
          onTasks={onPlan}
          onNotes={onNotebook}
          onPlans={onPlans}
          onReports={onReports}
        >
          <SpaceBell spaces={spaces} />
        </WorkspaceLinks>
        <NavigationFooter
          client="codex"
          captureScope={
            selected && !selected.unassigned
              ? { client: "codex", projectId: selected.id, name: selected.name }
              : null
          }
          onClient={onClient}
          onSettings={onSettings}
          onRemote={onRemote}
        />
      </div>
    </div>
  );
}
