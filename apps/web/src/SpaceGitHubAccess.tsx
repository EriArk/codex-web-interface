import type { GitHubIdentity } from "@codex-web/shared";
import { useEffect, useState } from "react";
import { pageWorkspace } from "./accountStorage";
import { api } from "./api";
import { sharedMutation, useSharedAction } from "./sharedRequests";
import type { Project } from "./types";

type Access = {
  identity: GitHubIdentity | null;
  grants: {
    projectId: string;
    userId: string;
    state: string;
    login: string | null;
    error?: string | null;
  }[];
};
const states: Record<string, string> = {
  "waiting-account": "Участник подключает GitHub",
  queued: "Выдаём Write…",
  running: "Выдаём Write…",
  pending: "Ожидает принятия",
  accepted: "GitHub Write предоставлен",
  failed: "Не удалось выдать Write",
  unknown: "Результат пока не подтверждён",
  cancelled: "Отменено",
  "not-synced": "GitHub Write ещё не проверен",
};
export function SpaceGitHubAccessPanel({
  spaceId,
  revision,
  projects,
  names = [],
}: {
  spaceId: string;
  revision: number;
  projects: Project[];
  names?: { id: string; name: string }[];
}) {
  const action = useSharedAction();
  const [value, setValue] = useState<Access | null>(null),
    [editing, setEditing] = useState(false),
    [selected, setSelected] = useState(""),
    [candidate, setCandidate] = useState<GitHubIdentity | null>(null);
  const choices = projects.filter((p) => !p.unassigned && !p.archived && !p.deleted);
  useEffect(() => {
    let active = true,
      timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const v = await api<Access>(`/team/spaces/${spaceId}/github-access?revision=${revision}`);
        if (active) {
          setValue(v);
          timer = setTimeout(
            load,
            v.grants.some((g) => ["running", "queued"].includes(g.state)) ? 2000 : 10000,
          );
        }
      } catch {
        if (active) timer = setTimeout(load, 10000);
      }
    };
    void load();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [spaceId, revision]);
  const name = (id: string) => names.find((n) => n.id === id)?.name ?? "Проект";
  return (
    <section className="space-form space-github-access" aria-label="Доступ GitHub">
      <div className="space-member">
        <strong>GitHub{value?.identity ? ` · @${value.identity.login}` : ""}</strong>
        {value?.identity && (
          <button className="secondary" type="button" onClick={() => setEditing((v) => !v)}>
            Сменить аккаунт
          </button>
        )}
      </div>
      {(!value?.identity || editing) && (
        <div className="space-form">
          <small className="muted">
            Подключи свой аккаунт для получения Write. Проверим GitHub на компьютере выбранного
            проекта.
          </small>
          <label>
            Мой проект
            <select
              aria-label="Проект для аккаунта GitHub"
              disabled={action.busy}
              value={selected}
              onChange={(e) => {
                setSelected(e.target.value);
                setCandidate(null);
              }}
            >
              <option value="">Выбрать проект…</option>
              {choices.map((p) => (
                <option value={p.id} key={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          {candidate && (
            <p>
              Использовать мой GitHub <strong>@{candidate.login}</strong>?
            </p>
          )}
          <div className="space-actions">
            <button
              type="button"
              className="primary"
              disabled={action.busy || !selected}
              onClick={() =>
                void action.run(async () => {
                  const result = await sharedMutation<{
                    identity: GitHubIdentity;
                    confirmed: boolean;
                  }>("/team/spaces/github-account", "POST", {
                    personalProjectId: selected,
                    ...(candidate ? { identity: candidate } : {}),
                  });
                  if (result.confirmed) {
                    setValue(await api<Access>(`/team/spaces/${spaceId}/github-access`));
                    setEditing(false);
                    setCandidate(null);
                  } else setCandidate(result.identity);
                })
              }
            >
              {candidate ? "Подключить аккаунт" : "Проверить аккаунт"}
            </button>
          </div>
        </div>
      )}
      {value?.grants.map((g) => (
        <div className="space-form" key={`${g.projectId}:${g.userId}`}>
          <small>
            <strong>{name(g.projectId)}</strong>
            {g.login
              ? ` · @${g.login}`
              : ` · ${names.find((n) => n.id === g.userId)?.name ?? "Участник"}`}
            <br />
            {states[g.state] ?? "Проверить доступ"}
            {g.error && (
              <>
                <br />
                {g.error}
              </>
            )}
          </small>
          <div className="space-actions">
            {g.userId === pageWorkspace && ["pending", "unknown"].includes(g.state) && (
              <button
                type="button"
                className="primary"
                disabled={action.busy}
                onClick={() =>
                  void action.run(async () => {
                    setValue(
                      await sharedMutation<Access>(
                        `/team/spaces/${spaceId}/github-accept`,
                        "POST",
                        { projectId: g.projectId },
                      ),
                    );
                  })
                }
              >
                Принять Write
              </button>
            )}
            <button
              type="button"
              className="secondary"
              disabled={action.busy || ["queued", "running"].includes(g.state)}
              onClick={() =>
                void action.run(async () => {
                  setValue(
                    await sharedMutation<Access>(`/team/spaces/${spaceId}/github-access`, "POST", {
                      projectId: g.projectId,
                      userId: g.userId,
                    }),
                  );
                })
              }
            >
              Проверить доступ
            </button>
          </div>
        </div>
      ))}
      {action.error && <p role="alert">{action.error}</p>}
    </section>
  );
}
