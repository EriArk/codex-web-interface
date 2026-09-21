import type { CollaborationSpace } from "@codex-web/shared";
import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { Icon } from "./icons";
import { sharedMutation, useSharedAction } from "./sharedRequests";
import type { Project, Thread } from "./types";
import type { SpacesController } from "./useCollaborationSpaces";

export function SpaceProjectOverview({
  spaces,
  space,
  projectId,
  projects,
  onNewProject,
  createdProjectId,
  onProject,
  onChat,
}: {
  spaces: SpacesController;
  space: CollaborationSpace;
  projectId: string;
  projects: Project[];
  onNewProject: (seed?: { name: string; repository: string }) => void;
  createdProjectId: string;
  onProject: (id: string) => void;
  onChat: (id: string, projectId: string) => void;
}) {
  const project = space.projects.find((p) => p.id === projectId);
  const action = useSharedAction();
  const [copy, setCopy] = useState("");
  const initialCreated = useRef(createdProjectId);
  const initialCopy = useRef(project?.personalProjectId);
  const openChat = useRef(onChat);
  openChat.current = onChat;
  useEffect(() => {
    if (initialCopy.current) onProject(initialCopy.current);
  }, [onProject]);
  useEffect(() => {
    if (createdProjectId && createdProjectId !== initialCreated.current) setCopy(createdProjectId);
  }, [createdProjectId]);
  if (!project) return null;
  const used = new Set(
    spaces.catalog.spaces.flatMap((s) => s.projects.map((p) => p.personalProjectId)),
  );
  const available = projects.filter(
    (p) => !p.unassigned && !p.archived && !p.deleted && !used.has(p.id),
  );
  const start = async () => {
    const thread = await api<Thread>(`/team/spaces/${space.id}/projects/${project.id}/chat`, {
      method: "POST",
      key: crypto.randomUUID(),
      body: {},
    });
    if (action.active()) openChat.current(thread.id, thread.projectId);
  };
  return (
    <section className="space-form" aria-label={`Проект ${project.name}`}>
      <h2>
        <Icon name="folder" size={20} /> {project.name}
      </h2>
      <a href={project.repository} target="_blank" rel="noreferrer">
        {project.repository}
      </a>
      {project.personalProjectId ? (
        <div className="space-actions">
          <button
            type="button"
            className="secondary"
            onClick={() => onProject(project.personalProjectId!)}
          >
            <Icon name="folder" size={18} /> Обзор, файлы и Git
          </button>
          <button
            type="button"
            className="primary"
            disabled={action.busy}
            onClick={() => void action.run(start)}
          >
            <Icon name="chat" size={18} /> Открыть Codex
          </button>
        </div>
      ) : project.access !== "none" ? (
        <form
          className="space-form"
          onSubmit={(e) => {
            e.preventDefault();
            void action.run(async () => {
              await sharedMutation(`/team/spaces/${space.id}/bind`, "POST", {
                revision: space.revision,
                projectId: project.id,
                personalProjectId: copy,
              });
              await spaces.refresh(true);
              await start();
            });
          }}
        >
          <p>Подключи свою рабочую копию, чтобы открыть файлы, код, Git и диалоги Codex.</p>
          <label>
            Моя рабочая копия
            <select
              value={copy}
              onChange={(e) => setCopy(e.target.value)}
              disabled={action.busy}
              required
            >
              <option value="">Выбрать проект…</option>
              {available.map((p) => (
                <option value={p.id} key={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <div className="space-actions">
            <button
              type="button"
              className="secondary"
              onClick={() => onNewProject({ name: project.name, repository: project.repository })}
            >
              Создать рабочую копию
            </button>
            <button
              type="submit"
              className="primary"
              disabled={action.busy || !available.some((p) => p.id === copy)}
            >
              Подключить и открыть Codex
            </button>
          </div>
        </form>
      ) : (
        <p>Доступ к проекту пока не предоставлен.</p>
      )}
      {action.error && <p role="alert">{action.error}</p>}
    </section>
  );
}
