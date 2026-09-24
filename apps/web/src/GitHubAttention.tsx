import type { CollaborationSpace, GitHubAttentionKind, SpaceActivityPage } from "@codex-web/shared";
import { useEffect, useState } from "react";
import { type ActivitySourceTarget, ActivitySourceWindow } from "./ActivitySourceWindow";
import { api, messageOf } from "./api";

const labels: Record<GitHubAttentionKind, string> = {
  assigned: "Назначено тебе",
  review: "Запрошено твоё ревью",
  checks: "Проверки твоего PR требуют внимания",
};

/** On-demand projection over canonical GitHub reads. Acknowledgement is local only. */
export function GitHubAttention({
  spaces,
  onCount,
}: {
  spaces: CollaborationSpace[];
  onCount: (count: number, busy: boolean) => void;
}) {
  const [pages, setPages] = useState<Record<string, SpaceActivityPage>>({});
  const [busy, setBusy] = useState(true),
    [error, setError] = useState("");
  const [reading, setReading] = useState("");
  const [target, setTarget] = useState<{
    space: CollaborationSpace;
    source: ActivitySourceTarget;
  } | null>(null);
  const scope = JSON.stringify(
    spaces.map((s) => [
      s.id,
      s.revision,
      s.projects
        .filter((p) => p.access !== "none" && p.personalProjectId)
        .map((p) => [p.id, p.personalProjectId, p.repository]),
    ]),
  );
  useEffect(() => {
    let live = true;
    const scopes = JSON.parse(scope) as [string, number, [string, string, string][]][];
    const allowed = new Set(
      scopes.flatMap(([id, revision, projects]) =>
        projects.map((p) => JSON.stringify([id, revision, ...p])),
      ),
    );
    setPages((old) => Object.fromEntries(Object.entries(old).filter(([key]) => allowed.has(key))));
    setBusy(true);
    setError("");
    void (async () => {
      for (const [id, revision, projects] of scopes)
        for (const [projectId, copy, repository] of projects) {
          if (!live) return;
          const key = JSON.stringify([id, revision, projectId, copy, repository]);
          try {
            const page = await api<SpaceActivityPage>(`/team/spaces/${id}/activity`, {
              method: "POST",
              body: { projectId },
            });
            if (live) setPages((old) => ({ ...old, [key]: page }));
          } catch (e) {
            if (live) {
              setPages((old) => Object.fromEntries(Object.entries(old).filter(([k]) => k !== key)));
              setError(messageOf(e));
            }
          }
        }
      if (live) setBusy(false);
    })();
    return () => {
      live = false;
    };
  }, [scope]);
  const notices = spaces
    .flatMap((space) =>
      space.projects.flatMap((project) => {
        if (project.access === "none" || !project.personalProjectId) return [];
        const page =
          pages[
            JSON.stringify([
              space.id,
              space.revision,
              project.id,
              project.personalProjectId,
              project.repository,
            ])
          ];
        return page
          ? page.items.flatMap((source) => {
              const notices = (source.attention ?? []).filter((n) => !n.read);
              return notices.length
                ? [
                    {
                      space,
                      project,
                      page,
                      source,
                      notices,
                      key: space.id + ":" + project.id + ":" + source.key,
                    },
                  ]
                : [];
            })
          : [];
      }),
    )
    .sort((a, b) => Date.parse(b.source.at) - Date.parse(a.source.at));
  useEffect(() => {
    onCount(notices.length, busy);
  }, [notices.length, busy, onCount]);
  const targetSpace = spaces.find(
    (s) => s.id === target?.space.id && s.revision === target.space.revision,
  );
  return (
    <>
      {notices.map((n) => (
        <section className="space-card" key={n.key}>
          <strong>
            {n.project.name} · {n.source.kind === "pr" ? "PR" : "Issue"} #{n.source.number}
          </strong>
          <small>{n.notices.map((v) => labels[v.kind]).join(" · ")}</small>
          <p>{n.source.title}</p>
          <div className="activity-notice-actions">
            <button
              className="secondary"
              type="button"
              onClick={() =>
                setTarget({
                  space: n.space,
                  source: {
                    projectId: n.project.id,
                    repositoryId: n.page.repositoryId,
                    source: n.source,
                  },
                })
              }
            >
              Открыть {n.source.kind === "pr" ? "PR" : "Issue"}
            </button>
            <button
              className="secondary"
              type="button"
              disabled={!!reading}
              onClick={() => {
                setReading(n.key);
                setError("");
                void api(`/team/spaces/${n.space.id}/activity/github-read`, {
                  method: "POST",
                  body: {
                    projectId: n.project.id,
                    repositoryId: n.page.repositoryId,
                    source: n.source.key,
                    versions: n.notices.map((v) => v.version),
                  },
                })
                  .then(() => {
                    setPages((old) => {
                      const key = JSON.stringify([
                        n.space.id,
                        n.space.revision,
                        n.project.id,
                        n.project.personalProjectId,
                        n.project.repository,
                      ]);
                      const page = old[key];
                      return page
                        ? {
                            ...old,
                            [key]: {
                              ...page,
                              items: page.items.map((source) =>
                                source.key === n.source.key
                                  ? {
                                      ...source,
                                      attention: source.attention?.map((v) =>
                                        n.notices.some((notice) => notice.version === v.version)
                                          ? { ...v, read: true }
                                          : v,
                                      ),
                                    }
                                  : source,
                              ),
                            },
                          }
                        : old;
                    });
                  })
                  .catch((e) => setError(messageOf(e)))
                  .finally(() => setReading(""));
              }}
            >
              Прочитано
            </button>
          </div>
        </section>
      ))}
      {busy && <small role="status">Проверяем адресованные события GitHub…</small>}
      {error && <p role="status">{error}</p>}
      {target && targetSpace && (
        <ActivitySourceWindow
          space={targetSpace}
          target={target.source}
          onClose={() => setTarget(null)}
        />
      )}
    </>
  );
}
