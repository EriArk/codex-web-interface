import type { NotebookScope, SharedProject } from "@codex-web/shared";
import { useMemo, useState } from "react";
import { pageWorkspace, accountLocalStorage as storage } from "./accountStorage";
import { useSharedResource } from "./sharedResources";

/** A submitted draft keeps its chosen destination through reload and membership changes. */
export function useWorkspaceAudience(scope: NotebookScope, id: string, personal = false) {
  const key =
    "workspace-audience:" + id + ":" + (scope ? scope.client + ":" + scope.projectId : "global");
  const [override, setOverride] = useState<{ key: string; value: string }>(),
    [error, setError] = useState("");
  const saved = useMemo(() => {
    try {
      return storage.getItem(key);
    } catch {
      return null;
    }
  }, [key]);
  const eligible = !!pageWorkspace && scope?.client === "codex";
  const resource = useSharedResource<{ project: SharedProject | null }>(
    eligible
      ? "/team/project-association?personalProjectId=" + encodeURIComponent(scope.projectId)
      : null,
  );
  const project = resource.value?.project?.visibility === "shared" ? resource.value.project : null;
  const writable = !!project && project.role !== "viewer" && !project.archived;
  const choice = override?.key === key ? override.value : saved;
  const projectId = choice?.startsWith("shared:")
    ? choice.slice(7)
    : choice === "personal" || personal
      ? null
      : writable
        ? project!.id
        : null;
  const ready = !!choice || personal || !eligible || !!resource.value;
  const select = (value: string) => {
    try {
      storage.setItem(key, value);
      setOverride({ key, value });
      setError("");
    } catch {
      setError("Не удалось сохранить выбор доступа на устройстве.");
    }
  };
  const freeze = () => {
    if (!pageWorkspace) return null;
    if (!ready || error)
      throw Error(error || resource.error || "Дождись проверки доступа к проекту.");
    const value = projectId ? "shared:" + projectId : "personal";
    storage.setItem(key, value);
    setOverride({ key, value });
    return projectId;
  };
  return {
    project,
    writable,
    projectId,
    ready,
    error: error || (!ready ? resource.error : undefined),
    select,
    freeze,
  };
}
export function WorkspaceAudience({
  value,
  disabled = false,
}: {
  value: ReturnType<typeof useWorkspaceAudience>;
  disabled?: boolean;
}) {
  if (!pageWorkspace) return null;
  return (
    <div className="workspace-audience">
      {!value.ready && (
        <p role={value.error ? "alert" : "status"}>
          {value.error ?? "Проверяем доступ к проекту…"}
        </p>
      )}
      {value.ready && (
        <>
          <label>
            Кто увидит запись
            <select
              aria-label="Доступ к записи"
              disabled={disabled}
              value={value.projectId ? "shared" : "personal"}
              onChange={(e) =>
                value.select(
                  e.target.value === "shared" ? "shared:" + value.project!.id : "personal",
                )
              }
            >
              {(value.project || value.projectId) && (
                <option value="shared" disabled={!value.writable}>
                  Участники проекта{value.project ? " «" + value.project.title + "»" : ""}
                </option>
              )}
              <option value="personal">Только я</option>
            </select>
          </label>
          {value.projectId && (
            <small>Будет сохранена в общих материалах. Личные чаты остаются закрытыми.</small>
          )}
          {value.project && !value.writable && (
            <small>Общие материалы этого проекта доступны тебе только для чтения.</small>
          )}
        </>
      )}
      {value.ready && value.error && <p role="alert">{value.error}</p>}
    </div>
  );
}
