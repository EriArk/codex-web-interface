import { type ProjectGpt, type ProjectRules, projectRuleLabels } from "@codex-web/shared";
import { useState } from "react";
import { AutoTextarea } from "./AutoTextarea";
import { api } from "./api";
import { useSharedAction } from "./sharedRequests";

export const emptyProjectRules: ProjectRules = { enabled: [], custom: "" };
export function ProjectRulesEditor({
  value,
  onChange,
}: {
  value: ProjectRules;
  onChange: (v: ProjectRules) => void;
}) {
  return (
    <div className="space-form project-rules-editor">
      {Object.entries(projectRuleLabels).map(([id, label]) => {
        const key = id as keyof typeof projectRuleLabels;
        return (
          <label className="project-rule" key={key}>
            <input
              type="checkbox"
              checked={value.enabled.includes(key)}
              onChange={(e) =>
                onChange({
                  ...value,
                  enabled: e.target.checked
                    ? [...value.enabled, key]
                    : value.enabled.filter((v) => v !== key),
                })
              }
            />
            {label}
          </label>
        );
      })}
      <label>
        Свои пожелания
        <AutoTextarea
          aria-label="Свои правила проекта"
          rows={3}
          maxLength={4000}
          value={value.custom}
          onChange={(e) => onChange({ ...value, custom: e.target.value })}
        />
      </label>
    </div>
  );
}
export function SpaceProjectRules({ projectId }: { projectId: string }) {
  const [rules, setRules] = useState<ProjectRules | null>(null);
  const action = useSharedAction();
  const path = `/projects/${encodeURIComponent(projectId)}/gpt`;
  return (
    <details
      className="space-form"
      onToggle={(e) => {
        if (e.currentTarget.open && !rules)
          void action.run(async () => {
            const data = await api<ProjectGpt>(path);
            if (action.active()) setRules(data.rules);
          });
      }}
    >
      <summary>Мои настройки Codex</summary>
      <p className="muted">
        Завершённая работа — коммит и отправка в разрешённую ветку. Дополнительные пожелания
        выбираешь ты.
      </p>
      {rules && (
        <fieldset disabled={action.busy}>
          <ProjectRulesEditor value={rules} onChange={setRules} />
          <button
            type="button"
            className="secondary"
            onClick={() =>
              void action.run(async () => {
                const d = await api<ProjectGpt>(`${path}/rules`, { method: "PUT", body: rules });
                setRules(d.rules);
              })
            }
          >
            Применить правила
          </button>
        </fieldset>
      )}
      {action.error && <p role="alert">{action.error}</p>}
    </details>
  );
}
