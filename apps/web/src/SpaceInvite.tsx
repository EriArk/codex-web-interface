import type {
  CollaborationAccess,
  CollaborationSpace,
  ProjectRules,
  TeamContact,
} from "@codex-web/shared";
import { useState } from "react";
import { pageWorkspace } from "./accountStorage";
import { emptyProjectRules, ProjectRulesEditor } from "./ProjectRulesEditor";
import { sharedMutation, useSharedAction } from "./sharedRequests";
import { TeamContactPicker } from "./TeamContactPicker";
import type { SpacesController } from "./useCollaborationSpaces";

export function SpaceInvite({
  space,
  spaces,
}: {
  space: CollaborationSpace;
  spaces: SpacesController;
}) {
  const [open, setOpen] = useState(false),
    [person, setPerson] = useState<TeamContact | null>(null);
  const [grants, setGrants] = useState<Record<string, CollaborationAccess | "">>({});
  const [rules, setRules] = useState<ProjectRules>(emptyProjectRules);
  const action = useSharedAction();
  if (!open)
    return (
      <button type="button" className="secondary" onClick={() => setOpen(true)}>
        Пригласить участника
      </button>
    );
  return (
    <form
      className="space-form"
      aria-label="Приглашение участника"
      onSubmit={(e) => {
        e.preventDefault();
        void action.run(async () => {
          await sharedMutation(`/team/spaces/${space.id}/invite`, "POST", {
            revision: space.revision,
            userId: person!.id,
            grants: space.projects
              .filter((p) => p.ownerId === pageWorkspace && (grants[p.id] ?? "collaborate"))
              .map((p) => ({ projectId: p.id, access: grants[p.id] ?? "collaborate" })),
            requestedAccess: "collaborate",
            ...(rules.enabled.length || rules.custom.trim() ? { recommendations: rules } : {}),
          });
          await spaces.refresh(true);
          setOpen(false);
          setPerson(null);
          setGrants({});
          setRules(emptyProjectRules);
        });
      }}
    >
      <fieldset disabled={action.busy}>
        <TeamContactPicker
          value={person}
          onChange={setPerson}
          exclude={[...space.members, ...space.pending].map((m) => m.id)}
        />
        {space.projects
          .filter((p) => p.ownerId === pageWorkspace)
          .map((p) => (
            <label key={p.id}>
              {p.name}
              <select
                aria-label={`Приглашение: ${p.name}`}
                value={grants[p.id] ?? "collaborate"}
                onChange={(e) =>
                  setGrants((old) => ({
                    ...old,
                    [p.id]: e.target.value as CollaborationAccess | "",
                  }))
                }
              >
                {space.kind !== "project" && <option value="">Без доступа</option>}
                <option value="collaborate">Совместная работа</option>
                <option value="direct">Прямая работа</option>
              </select>
            </label>
          ))}
        {space.projects.some((p) => p.ownerId !== pageWorkspace) && (
          <p className="muted">
            Доступ к остальным проектам назначат их владельцы. Приглашённый сам выберет доступ к
            своему проекту.
          </p>
        )}
        <details>
          <summary>Рекомендации Codex</summary>
          <ProjectRulesEditor value={rules} onChange={setRules} />
        </details>
        <div className="space-actions">
          <button type="button" className="secondary" onClick={() => setOpen(false)}>
            Отмена
          </button>
          <button className="primary" type="submit" disabled={!person || !space.projects.length}>
            Пригласить
          </button>
        </div>
      </fieldset>
      {action.error && <p role="alert">{action.error}</p>}
    </form>
  );
}
