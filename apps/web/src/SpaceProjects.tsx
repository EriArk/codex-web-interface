import type { CollaborationAccess, CollaborationSpace } from "@codex-web/shared";
import { useEffect, useRef, useState } from "react";
import { pageWorkspace } from "./accountStorage";
import { Icon } from "./icons";
import { SpaceProjectRules } from "./ProjectRulesEditor";
import { sharedMutation, useSharedAction } from "./sharedRequests";
import type { Project } from "./types";
import type { SpacesController } from "./useCollaborationSpaces";

const labels = {
  owner: "Владелец",
  none: "Доступ не предоставлен",
  collaborate: "Совместная работа",
  direct: "Прямая работа",
};
export function SpaceProjects({
  spaces,
  space,
  projects,
  onNewProject,
  createdProjectId,
}: {
  spaces: SpacesController;
  space: CollaborationSpace;
  projects: Project[];
  onNewProject: () => void;
  createdProjectId: string;
}) {
  const action = useSharedAction();
  const [picker, setPicker] = useState<string | null>(null),
    [projectId, setProjectId] = useState("");
  const [access, setAccess] = useState<CollaborationAccess>("collaborate");
  const [removing, setRemoving] = useState<{
    kind: "project" | "member";
    id: string;
    name: string;
  } | null>(null);
  const initialCreated = useRef(createdProjectId);
  useEffect(() => {
    if (createdProjectId && createdProjectId !== initialCreated.current)
      setProjectId(createdProjectId);
  }, [createdProjectId]);
  const used = new Set(
    spaces.catalog.spaces.flatMap((s) => s.projects.map((p) => p.personalProjectId)),
  );
  const available = projects.filter(
    (p) => !p.unassigned && !p.archived && !p.deleted && !used.has(p.id),
  );
  const mutate = (op: string, body: Record<string, unknown>, done?: () => void) =>
    void action.run(async () => {
      await sharedMutation(`/team/spaces/${space.id}/${op}`, "POST", {
        revision: space.revision,
        ...body,
      });
      await spaces.refresh(true);
      done?.();
    });
  const openPicker = (id: string) => {
    setPicker(id);
    setProjectId("");
    setAccess("collaborate");
  };
  return (
    <section className="space-project-settings space-form" aria-label="Проекты и доступы">
      {space.projects.map((p) => (
        <details className="space-project-card" key={p.id}>
          <summary>
            <Icon name="repository" size={18} />
            <span>
              <strong>{p.name}</strong>
              <small>{labels[p.access]}</small>
            </span>
            <Icon name="chevron" size={16} />
          </summary>
          <div className="space-form">
            <a href={p.repository} target="_blank" rel="noreferrer">
              {p.repository.replace("https://github.com/", "")}
            </a>
            {p.ownerId === pageWorkspace ? (
              <>
                {[...space.members, ...space.pending]
                  .filter((m) => m.id !== pageWorkspace)
                  .map((m) => (
                    <div className="space-form" key={m.id}>
                      <label>
                        {m.name}
                        <select
                          aria-label={`Доступ: ${p.name} · ${m.name}`}
                          disabled={action.busy}
                          value={p.grants.find((g) => g.userId === m.id)?.access ?? ""}
                          onChange={(e) =>
                            mutate("grant", {
                              projectId: p.id,
                              userId: m.id,
                              access: e.target.value,
                            })
                          }
                        >
                          <option value="" disabled>
                            Доступ не предоставлен
                          </option>
                          <option value="collaborate">Совместная работа</option>
                          <option value="direct">Прямая работа</option>
                        </select>
                      </label>
                      {p.requests.includes(m.id) && (
                        <div className="space-form">
                          <p>{m.name} просит прямой доступ.</p>
                          <div className="space-actions">
                            <button
                              type="button"
                              className="secondary"
                              disabled={action.busy}
                              onClick={() =>
                                mutate("grant", {
                                  projectId: p.id,
                                  userId: m.id,
                                  access: "collaborate",
                                })
                              }
                            >
                              Оставить совместный
                            </button>
                            <button
                              type="button"
                              className="primary"
                              disabled={action.busy}
                              onClick={() =>
                                mutate("grant", { projectId: p.id, userId: m.id, access: "direct" })
                              }
                            >
                              Разрешить
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setRemoving({ kind: "project", id: p.id, name: p.name })}
                >
                  Убрать из пространства
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="secondary"
                  disabled={action.busy || p.access === "none"}
                  onClick={() => openPicker(p.id)}
                >
                  {p.personalProjectId ? "Сменить рабочую копию" : "Подключить мою копию"}
                </button>
                {(p.access === "collaborate" || p.access === "none") &&
                  (p.requests.includes(pageWorkspace) ? (
                    <small className="muted">Прямой доступ запрошен</small>
                  ) : (
                    <button
                      type="button"
                      className="secondary"
                      disabled={action.busy}
                      onClick={() => mutate("request-access", { projectId: p.id })}
                    >
                      Запросить прямой доступ
                    </button>
                  ))}
              </>
            )}
            {p.personalProjectId && <SpaceProjectRules projectId={p.personalProjectId} />}
          </div>
        </details>
      ))}
      {picker !== null ? (
        <form
          className="space-form"
          onSubmit={(e) => {
            e.preventDefault();
            mutate(
              picker ? "bind" : "add-project",
              { personalProjectId: projectId, ...(picker ? { projectId: picker } : { access }) },
              () => setPicker(null),
            );
          }}
        >
          <label>
            {picker ? "Моя локальная копия" : "Добавить свой проект"}
            <select
              aria-label="Проект для подключения"
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              required
              disabled={action.busy}
            >
              <option value="">Выбрать проект…</option>
              {available.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="secondary" onClick={onNewProject}>
            Создать проект
          </button>
          {!picker && (
            <label>
              Доступ участникам
              <select
                aria-label="Доступ участникам"
                value={access}
                onChange={(e) => setAccess(e.target.value as CollaborationAccess)}
              >
                <option value="collaborate">Совместная работа</option>
                <option value="direct">Прямая работа</option>
              </select>
            </label>
          )}
          <div className="space-actions">
            <button type="button" className="secondary" onClick={() => setPicker(null)}>
              Отмена
            </button>
            <button
              type="submit"
              className="primary"
              disabled={action.busy || !available.some((p) => p.id === projectId)}
            >
              Подключить
            </button>
          </div>
        </form>
      ) : (
        (space.kind === "space" || !space.projects.length) && (
          <button type="button" className="secondary" onClick={() => openPicker("")}>
            <Icon name="plus" size={17} />
            Добавить свой проект
          </button>
        )
      )}
      {space.curatorId === pageWorkspace &&
        [...space.members, ...space.pending]
          .filter((m) => m.id !== pageWorkspace)
          .map((m) => (
            <div className="space-member" key={m.id}>
              <span>{m.name}</span>
              <button
                type="button"
                className="secondary"
                onClick={() => setRemoving({ kind: "member", id: m.id, name: m.name })}
              >
                {space.pending.some((p) => p.id === m.id)
                  ? "Отменить приглашение"
                  : "Убрать участника"}
              </button>
            </div>
          ))}
      {removing && (
        <fieldset className="space-form" aria-label="Подтверждение удаления из пространства">
          <p>Убрать «{removing.name}» из пространства? Файлы и личные диалоги сохранятся.</p>
          <div className="space-actions">
            <button
              type="button"
              className="secondary"
              disabled={action.busy}
              onClick={() => setRemoving(null)}
            >
              Отмена
            </button>
            <button
              type="button"
              className="danger"
              disabled={action.busy}
              onClick={() =>
                mutate(
                  removing.kind === "project" ? "remove-project" : "remove-member",
                  removing.kind === "project"
                    ? { projectId: removing.id }
                    : { userId: removing.id },
                  () => setRemoving(null),
                )
              }
            >
              Убрать
            </button>
          </div>
        </fieldset>
      )}
      {action.error && <p role="alert">{action.error}</p>}
    </section>
  );
}
