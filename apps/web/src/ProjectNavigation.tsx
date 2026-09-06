import { useState } from "react";
import { Icon } from "./icons";
import type { Project, Thread } from "./types";
export function ProjectNavigation({
  projects,
  threads,
  projectId,
  threadId,
  busy,
  loading,
  machine,
  onProject,
  onThread,
  onNewThread,
  onNewProject,
  onRefresh,
  onClose,
  onSettings,
}: {
  projects: Project[];
  threads: Thread[];
  projectId: string;
  threadId: string;
  busy: boolean;
  loading: boolean;
  machine: string;
  onProject: (id: string) => void;
  onThread: (id: string) => void;
  onNewThread: () => void;
  onNewProject: () => void;
  onRefresh: () => void;
  onClose: () => void;
  onSettings: () => void;
}) {
  const [section, setSection] = useState<"projects" | "threads">("threads"),
    [query, setQuery] = useState("");
  const selected = projects.find((p) => p.id === projectId);
  const matches = (text: string) =>
    text.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
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
          Проекты <span>{projects.length}</span>
        </button>
        <button
          type="button"
          className={section === "threads" ? "selected" : ""}
          onClick={() => {
            setSection("threads");
            setQuery("");
          }}
        >
          Диалоги <span>{threads.length}</span>
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
          {loading && !projects.length && (
            <p className="nav-empty" role="status">
              Подключаем твои проекты…
            </p>
          )}
          {projects
            .filter((p) => matches(p.name))
            .map((p, index) => (
              <button
                type="button"
                key={p.id}
                className={`nav-project ${projectId === p.id ? "selected" : ""}`}
                disabled={busy}
                onClick={() => {
                  onProject(p.id);
                  setSection("threads");
                  setQuery("");
                }}
              >
                <span className={`folder-icon folder-${index % 5}`}>
                  <Icon name="folder" />
                </span>
                <span>
                  {p.name}
                  <small>{p.machineName}</small>
                </span>
              </button>
            ))}
          {!loading && query && !projects.some((p) => matches(p.name)) && (
            <p className="nav-empty">Проект не найден</p>
          )}
          <button type="button" className="nav-add-project" onClick={onNewProject} disabled={busy}>
            <Icon name="plus" size={16} />
            Новый проект
          </button>
        </section>
        <section className="nav-threads">
          <button
            type="button"
            className="nav-current-project mobile-only"
            onClick={() => setSection("projects")}
          >
            <Icon name="folder" size={17} />
            <span>{selected?.name ?? "Выбрать проект"}</span>
            <Icon name="chevron" size={16} />
          </button>
          <div className="nav-label threads-label">
            Диалоги
            <button
              type="button"
              className="icon-button"
              onClick={onNewThread}
              disabled={busy || !projectId}
              aria-label="Новый диалог"
            >
              <Icon name="plus" size={18} />
            </button>
          </div>
          {!threads.length && (
            <p className="nav-empty">
              {loading ? "Обновляем диалоги…" : "Начни новую задачу в этом проекте."}
            </p>
          )}
          {threads
            .filter((t) => matches(t.title))
            .map((t) => (
              <button
                type="button"
                className={`nav-thread ${threadId === t.id ? "selected" : ""}`}
                key={t.id}
                disabled={busy}
                onClick={() => onThread(t.id)}
              >
                <Icon name="chat" size={17} />
                <span>{t.title}</span>
                {["running", "starting", "waiting_approval"].includes(t.status) && (
                  <span className="status-dot online" />
                )}
              </button>
            ))}
          {query && threads.length > 0 && !threads.some((t) => matches(t.title)) && (
            <p className="nav-empty">Диалог не найден</p>
          )}
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
