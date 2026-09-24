import type {
  CurrentProjectChat,
  NotebookLink,
  NotebookScope,
  NotebookTarget,
  ProjectOverview as Overview,
  OverviewThread,
} from "@codex-web/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityBadge } from "./ActivityBadge";
import { AgentProfileButton } from "./AgentProfileEditor";
import { workspaceMediaUrl } from "./accountStorage.ts";
import { api, messageOf } from "./api";
import { GptProjectButton } from "./GptProjectContent";
import { GuiPreviewButton } from "./GuiPreviewHost";
import { IntakeButton } from "./IntakeWindow";
import { IssueDrawerButton } from "./IssueDrawer";
import { Icon } from "./icons";
import { cleanTarget, type NotebookRequest } from "./Notebook";
import { PinnedList } from "./PinnedList";
import { DeliveryButton } from "./ProjectDeliveryHost";
import { ProjectRelays } from "./ProjectRelays";
import { ProjectRotation } from "./ProjectRotation";
import { SharedProjectsButton } from "./TeamProjectsHost";
import { reviewLabels } from "./WorkReviewLink";
import "./project-overview.css";
export function ProjectOverview({
  scope,
  onTarget,
  onNotebook,
  onNew,
  onFiles,
  onGit,
  onMachines,
  onResults,
  onRemote,
  onProjectGpt,
  cachedThreads,
  onClose,
}: {
  scope: Exclude<NotebookScope, null>;
  onTarget: (t: NotebookLink) => void;
  onNotebook: (r: NotebookRequest) => void;
  onNew?: () => void;
  onFiles?: () => void;
  onGit?: () => void;
  onMachines?: () => void;
  onResults?: () => void;
  onRemote?: () => void;
  onProjectGpt?: () => void;
  cachedThreads?: OverviewThread[];
  onClose?: () => void;
}) {
  const [data, setData] = useState<Overview | null>(null),
    [error, setError] = useState(""),
    [revision, setRevision] = useState(0),
    [opening, setOpening] = useState(false),
    [rotation, setRotation] = useState(false);
  const rotationChanged = useCallback(() => setRevision((n) => n + 1), []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Explicit refresh repeats a bounded cached overview read.
  useEffect(() => {
    const controller = new AbortController();
    let busy = false;
    setData(null);
    setError("");
    const refresh = async () => {
      if (busy || document.hidden) return;
      busy = true;
      try {
        const value = await api<Overview>(
          `/workspace/overview?client=${scope.client}&projectId=${encodeURIComponent(scope.projectId)}`,
          { signal: controller.signal },
        );
        if (!controller.signal.aborted) {
          setData(value);
          setError("");
        }
      } catch (e) {
        if (!controller.signal.aborted) setError(messageOf(e));
      } finally {
        busy = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 30000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      controller.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [scope.client, scope.projectId, revision]);
  const pendingOpen = useRef<AbortController | null>(null);
  useEffect(() => () => pendingOpen.current?.abort(), []);
  const open = async (target: NotebookTarget) => {
    if (opening) return;
    const controller = new AbortController();
    pendingOpen.current = controller;
    setOpening(true);
    setError("");
    try {
      const resolved = await api<NotebookLink>("/workspace/resolve", {
        method: "POST",
        body: cleanTarget(target),
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (resolved.availability === "missing")
        throw Error("Источник удалён или недоступен. Ссылка сохранена.");
      onTarget(resolved);
    } catch (e) {
      if (!controller.signal.aborted) setError(messageOf(e));
    } finally {
      if (!controller.signal.aborted) setOpening(false);
    }
  };
  const threads = cachedThreads ?? data?.threads ?? [],
    date = (time: number) =>
      new Date(time).toLocaleString("ru", {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      });
  const current = data?.currentChat;
  const currentRow = current?.threadId
    ? (threads.find((t) => t.id === current.threadId) ?? {
        id: current.threadId,
        title: current.title,
        status: current.status,
        active: ["running", "starting", "waiting_approval"].includes(current.status),
        unread: false,
      })
    : null;
  const threadButton = (t: {
    id: string;
    title: string;
    status: string;
    active: boolean;
    unread: boolean;
  }) => (
    <button
      type="button"
      className="overview-row"
      key={t.id}
      data-thread-id={t.id}
      disabled={opening}
      onClick={() =>
        void open({
          client: scope.client,
          kind: "thread",
          id: t.id,
          threadId: t.id,
          projectId: scope.projectId,
          title: t.title,
        })
      }
    >
      <Icon name="chat" />
      <span>
        {t.title}
        {t.status === "unknown" && <small>Статус неизвестен</small>}
      </span>
      <ActivityBadge
        active={Number(t.active)}
        unread={Number(t.unread)}
        waiting={Number(t.status === "waiting_approval")}
      />
      <Icon name="chevron" size={15} />
    </button>
  );
  return (
    <section className="project-overview pane" aria-label={`Обзор проекта ${scope.name}`}>
      <header className="project-overview-heading">
        <div>
          <small>Обзор проекта</small>
          <h1>{scope.name}</h1>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="Обновить обзор проекта"
          onClick={() => setRevision((v) => v + 1)}
        >
          <Icon name="refresh" />
        </button>
        {onClose && (
          <button
            type="button"
            className="icon-button panel-close"
            aria-label="Закрыть обзор проекта"
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        )}
      </header>
      <div className="project-overview-scroll">
        {scope.client === "codex" && (
          <AgentProfileButton projectId={scope.projectId} name={scope.name} />
        )}
        {scope.client === "codex" && onProjectGpt && (
          <button type="button" className="overview-row" onClick={onProjectGpt}>
            <Icon name="chat" />
            <span>
              <strong>GPT проекта</strong>
              <small>Личный чат для обсуждения проекта</small>
            </span>
            <Icon name="chevron" size={16} />
          </button>
        )}
        <SharedProjectsButton scope={scope} />
        <IssueDrawerButton
          targetId={scope.client === "codex" ? scope.projectId : undefined}
          className="overview-row"
        />
        {scope.client === "codex" && (
          <IntakeButton
            projectId={scope.projectId}
            name={scope.name}
            onWork={onTarget}
            className="overview-row"
            label="Разобрать входящие задачи"
          />
        )}
        {error && (
          <p className="notice" role="alert">
            {error}
          </p>
        )}
        {!data && !error && (
          <p role="status">
            <span className="spinner" /> Загружаю…
          </p>
        )}
        {data && (
          <div className="project-overview-grid">
            <div className="overview-main">
              {!!data.reviews?.length && (
                <section className="overview-card" aria-label="Приёмка работы">
                  <header>
                    <h2>Приёмка</h2>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label="Все приёмки проекта"
                      onClick={() => onNotebook({ scope, mode: "reviews" })}
                    >
                      <Icon name="chevron" />
                    </button>
                  </header>
                  {data.reviews.map((r) => (
                    <button
                      type="button"
                      className="overview-row"
                      key={r.id}
                      onClick={() => onNotebook({ scope, mode: "reviews", itemId: r.id })}
                    >
                      <Icon name={r.state === "accepted" ? "check" : "plan"} size={18} />
                      <span>
                        <strong>{r.title}</strong>
                        <small>{reviewLabels[r.state]}</small>
                      </span>
                      <Icon name="chevron" size={16} />
                    </button>
                  ))}
                </section>
              )}
              <section className="overview-card overview-continue" aria-label="Продолжить работу">
                <header>
                  <h2>Продолжить</h2>
                  {data.activity && (
                    <ActivityBadge active={data.activity.active} unread={data.activity.unread} />
                  )}
                </header>
                {currentRow ? (
                  <>
                    <small className="overview-current-label">Текущий чат</small>
                    {threadButton(currentRow)}
                    <button type="button" className="secondary" onClick={() => setRotation(true)}>
                      <Icon name="history" size={18} />
                      Продолжить в новом чате
                    </button>
                    {!!current?.history.length && (
                      <details className="overview-chat-history">
                        <summary>Предыдущие чаты · {current.history.length}</summary>
                        {current.history.map((t) =>
                          threadButton({
                            ...t,
                            id: t.threadId,
                            status: "idle",
                            active: false,
                            unread: false,
                          }),
                        )}
                      </details>
                    )}
                    {threads.some(
                      (t) =>
                        t.id !== currentRow.id &&
                        !current?.history.some((h) => h.threadId === t.id),
                    ) && (
                      <details className="overview-chat-history">
                        <summary>Другие чаты</summary>
                        {threads
                          .filter(
                            (t) =>
                              t.id !== currentRow.id &&
                              !current?.history.some((h) => h.threadId === t.id),
                          )
                          .slice(0, 10)
                          .map(threadButton)}
                      </details>
                    )}
                  </>
                ) : (
                  <>
                    {current?.explicit && (
                      <p className="muted">Рабочий чат недоступен. Выбери другой.</p>
                    )}
                    {threads.slice(0, 4).map((t) => (
                      <div className="overview-current-repair" key={t.id}>
                        {threadButton(t)}
                        {current?.explicit && (
                          <button
                            type="button"
                            className="icon-button"
                            disabled={opening}
                            aria-label={"Сделать рабочим: " + t.title}
                            onClick={async () => {
                              if (opening) return;
                              setOpening(true);
                              setError("");
                              const controller = new AbortController();
                              pendingOpen.current = controller;
                              try {
                                const next = await api<CurrentProjectChat>(
                                  "/workspace/current/restore",
                                  {
                                    method: "POST",
                                    body: {
                                      scope,
                                      threadId: t.id,
                                      revision: current.revision,
                                      confirm: true,
                                    },
                                    signal: controller.signal,
                                  },
                                );
                                if (!controller.signal.aborted)
                                  setData((old) => (old ? { ...old, currentChat: next } : old));
                              } catch (e) {
                                if (!controller.signal.aborted) setError(messageOf(e));
                              } finally {
                                if (!controller.signal.aborted) setOpening(false);
                              }
                            }}
                          >
                            <Icon name="check" />
                          </button>
                        )}
                      </div>
                    ))}
                  </>
                )}
                {!threads.length && <p className="muted">Пока нет диалогов.</p>}
                {onNew && !currentRow && (
                  <button type="button" className="secondary" onClick={onNew}>
                    <Icon name="plus" />
                    Новый диалог
                  </button>
                )}
              </section>
              <section className="overview-card" aria-label="Текущие задачи">
                <header>
                  <h2>Задачи проекта</h2>
                  <button type="button" onClick={() => onNotebook({ scope, mode: "tasks" })}>
                    Задачи <Icon name="chevron" size={14} />
                  </button>
                </header>
                {data.tasks.map((t) => (
                  <button
                    type="button"
                    className="overview-row"
                    key={t.id}
                    disabled={opening}
                    onClick={() => onNotebook({ scope, mode: "tasks", itemId: t.id })}
                  >
                    <span className="task-circle" />
                    <span>
                      {t.title}
                      <small>
                        {t.status === "doing"
                          ? "В работе"
                          : t.status === "blocked"
                            ? "Заблокировано"
                            : t.priority === 2
                              ? "Высокий приоритет"
                              : "Открыта"}
                        {t.dueAt ? ` · ${t.dueAt}` : ""}
                      </small>
                    </span>
                  </button>
                ))}
                {!data.tasks.length && (
                  <button
                    type="button"
                    className="overview-row muted"
                    onClick={() => onNotebook({ scope, mode: "tasks" })}
                  >
                    <Icon name="plus" />
                    Добавить задачу
                  </button>
                )}
              </section>
              <section className="overview-card" aria-label="Планы проекта">
                <header>
                  <h2>Планы</h2>
                  <button type="button" onClick={() => onNotebook({ scope, mode: "plans" })}>
                    Открыть <Icon name="chevron" size={14} />
                  </button>
                </header>
                {data.plans?.map((p) => (
                  <button
                    type="button"
                    className="overview-row"
                    key={p.id}
                    onClick={() => onNotebook({ scope, mode: "plans", itemId: p.id })}
                  >
                    <Icon name="plan" />
                    <span>
                      {p.title}
                      <small>
                        {p.checked}/{p.total}
                        {p.status === "done" ? " · Выполнен" : ""}
                      </small>
                    </span>
                  </button>
                ))}
                {!data.plans?.length && (
                  <button
                    type="button"
                    className="overview-row muted"
                    onClick={() => onNotebook({ scope, mode: "plans" })}
                  >
                    <Icon name="plus" />
                    Создать план
                  </button>
                )}
              </section>
              {data.results.length > 0 && (
                <section
                  className="overview-card overview-results"
                  aria-label="Последние результаты"
                >
                  <header>
                    <h2>Последние результаты</h2>
                    {onResults && (
                      <button type="button" onClick={onResults}>
                        Все <Icon name="chevron" size={14} />
                      </button>
                    )}
                  </header>
                  <div>
                    {data.results.map((result) => (
                      <button
                        type="button"
                        key={result.id}
                        disabled={opening}
                        className="overview-result"
                        onClick={() =>
                          void open({
                            client: scope.client,
                            kind: "result",
                            id: result.id,
                            threadId: result.threadId,
                            turnId: result.turnId,
                            projectId: scope.projectId,
                            title: result.title,
                          })
                        }
                      >
                        {result.imageUrl ? (
                          <img src={workspaceMediaUrl(result.imageUrl)} loading="lazy" alt="" />
                        ) : (
                          <Icon
                            name={
                              result.type === "image"
                                ? "image"
                                : result.type === "check"
                                  ? "check"
                                  : "file"
                            }
                            size={28}
                          />
                        )}
                        <span>{result.title}</span>
                      </button>
                    ))}
                  </div>
                </section>
              )}
            </div>
            <div className="overview-context">
              {scope.client === "gpt" && (
                <GptProjectButton key={scope.projectId} projectId={scope.projectId} />
              )}
              {scope.client === "codex" && (
                <ProjectRelays
                  key={scope.projectId}
                  projectId={scope.projectId}
                  onTarget={onTarget}
                  onNotebook={onNotebook}
                />
              )}
              <section className="overview-card" aria-label="Контекст проекта">
                <header>
                  <h2>Под рукой</h2>
                  <button type="button" onClick={() => onNotebook({ scope })}>
                    Заметки <Icon name="chevron" size={14} />
                  </button>
                </header>
                <PinnedList
                  items={data.pins}
                  active={() => false}
                  recent={(p) => p.createdAt}
                  storageKey={`overview:${scope.client}:${scope.projectId}`}
                  renderItem={(p) => (
                    <button
                      type="button"
                      className="overview-row"
                      key={p.id}
                      disabled={opening || p.target.availability === "missing"}
                      onClick={() => void open(p.target)}
                    >
                      <Icon name="pin" size={16} />
                      <span>
                        {p.target.title}
                        {p.target.availability === "missing" && <small>Источник недоступен</small>}
                      </span>
                    </button>
                  )}
                />
                {data.notes
                  .filter(
                    (n) => !data.pins.some((p) => p.target.kind === "note" && p.target.id === n.id),
                  )
                  .map((n) => (
                    <button
                      type="button"
                      className="overview-row"
                      key={n.id}
                      onClick={() => onNotebook({ scope, itemId: n.id })}
                    >
                      <Icon name="file" size={16} />
                      <span>{n.title}</span>
                    </button>
                  ))}
                {!data.pins.length && !data.notes.length && (
                  <button
                    type="button"
                    className="overview-row muted"
                    onClick={() => onNotebook({ scope })}
                  >
                    <Icon name="plus" />
                    Добавить заметку
                  </button>
                )}
              </section>
              <section className="overview-card" aria-label="Основа проекта">
                <header>
                  <h2>Основа проекта</h2>
                  <button type="button" onClick={() => onNotebook({ scope, mode: "core" })}>
                    Открыть <Icon name="chevron" size={14} />
                  </button>
                </header>
                <p className="overview-core-summary">
                  {data.core?.purpose || "Назначение, правила и ограничения проекта."}
                </p>
                {!!data.core?.revision && (
                  <small className="muted">Версия {data.core.revision}</small>
                )}
              </section>
              <section className="overview-card" aria-label="Отчёты проекта">
                <header>
                  <h2>Последний отчёт</h2>
                  <button type="button" onClick={() => onNotebook({ scope, mode: "reports" })}>
                    Все отчёты <Icon name="chevron" size={14} />
                  </button>
                </header>
                {data.latestReport ? (
                  <button
                    type="button"
                    className="overview-row"
                    onClick={() =>
                      onNotebook({ scope, mode: "reports", itemId: data.latestReport!.id })
                    }
                  >
                    <Icon name="report" />
                    <span>
                      {date(data.latestReport.createdAt)}
                      <small>{data.latestReport.excerpt}</small>
                    </span>
                  </button>
                ) : (
                  <button
                    type="button"
                    className="overview-row muted"
                    onClick={() => onNotebook({ scope, mode: "reports" })}
                  >
                    <Icon name="report" />
                    Подготовить отчёт
                  </button>
                )}
              </section>
              {(data.machine || onFiles) && (
                <section className="overview-card overview-system" aria-label="Состояние проекта">
                  <header>
                    <h2>Состояние проекта</h2>
                    {onMachines && (
                      <button type="button" onClick={onMachines}>
                        Компьютеры <Icon name="chevron" size={14} />
                      </button>
                    )}
                  </header>
                  {data.machine && (
                    <div className="overview-machine">
                      <Icon name="remote" />
                      <div>
                        <strong>{data.machine.name}</strong>
                        <p>
                          {data.machine.checkedAt
                            ? `${data.machine.stale ? "Прошлая проверка" : "Проверено"}: ${date(data.machine.checkedAt)}`
                            : "Ещё не проверен"}
                        </p>
                        {data.machine.checkedAt && (
                          <small>
                            {data.machine.online ? "SSH / хост доступен" : "Хост недоступен"} ·{" "}
                            {data.machine.codex ? "Codex отвечает" : "Codex не подтверждён"}
                          </small>
                        )}
                      </div>
                      {data.machine.remoteAvailable && onRemote && (
                        <button
                          type="button"
                          className="icon-button"
                          aria-label="Remote проекта"
                          onClick={onRemote}
                        >
                          <Icon name="expand" />
                        </button>
                      )}
                    </div>
                  )}
                  {onFiles && (
                    <DeliveryButton projectId={scope.projectId} projectName={scope.name} />
                  )}
                  {onFiles && (
                    <GuiPreviewButton projectId={scope.projectId} projectName={scope.name} />
                  )}
                  {onFiles && (
                    <button type="button" className="overview-row" onClick={onFiles}>
                      <Icon name="folder" />
                      <span>Файлы проекта</span>
                      <Icon name="chevron" size={15} />
                    </button>
                  )}
                  {onGit && (
                    <button type="button" className="overview-row" onClick={onGit}>
                      <Icon name="branch" />
                      <span>
                        {data.git
                          ? data.git.repository
                            ? `${data.git.branch ?? (data.git.detached ? "Detached HEAD" : "Git")} · ${data.git.dirty ? `Изменено: ${data.git.changed}` : "Без изменений"}`
                            : "Папка без Git"
                          : "Git проекта"}
                        {data.git && (
                          <small>
                            {data.git.stale ? "Прошлая проверка" : "Проверено"}:{" "}
                            {date(data.git.checkedAt)}
                          </small>
                        )}
                      </span>
                      <Icon name="chevron" size={15} />
                    </button>
                  )}
                </section>
              )}
            </div>
          </div>
        )}
      </div>
      {rotation && (
        <ProjectRotation
          scope={scope}
          onClose={() => setRotation(false)}
          onOpen={onTarget}
          onChanged={rotationChanged}
        />
      )}
    </section>
  );
}
