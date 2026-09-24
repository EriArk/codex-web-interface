import type { CollaborationSpace, GitHubAttentionKind, SpaceActivityPage } from "@codex-web/shared";
import { useEffect, useRef, useState } from "react";
import { type ActivitySourceTarget, ActivitySourceWindow } from "./ActivitySourceWindow";
import { mergeActivityPage } from "./activityCache";
import { ApiError, api, messageOf } from "./api";
import { readAttentionView, saveAttentionView } from "./attentionCache";
import { Icon } from "./icons";

const labels: Record<GitHubAttentionKind, string> = {
  assigned: "Назначено тебе",
  review: "Запрошено твоё ревью",
  checks: "Проверки твоего PR требуют внимания",
  "review-changes": "Запрошены изменения в твоём PR",
};
const readKey = (page: SpaceActivityPage, source: string, version: string) =>
  JSON.stringify([page.projectId, page.repositoryId, page.viewerId, source, version]);

/** On-demand projection over canonical GitHub reads. Acknowledgement is local only. */
export function GitHubAttention({
  spaces,
  onCount,
}: {
  spaces: CollaborationSpace[];
  onCount: (count: number, busy: boolean) => void;
}) {
  const [busy, setBusy] = useState(true),
    [error, setError] = useState("");
  const [reading, setReading] = useState("");
  const [target, setTarget] = useState<{
    space: CollaborationSpace;
    source: ActivitySourceTarget;
  } | null>(null);
  const scope = JSON.stringify(
    [...spaces]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((s) => [
        s.id,
        s.revision,
        s.projects
          .filter((p) => p.access !== "none" && p.personalProjectId)
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((p) => [p.id, p.personalProjectId, p.repository]),
      ]),
  );
  const [initial] = useState(() => readAttentionView(scope));
  const initialScope = useRef(scope);
  const scrollPosition = useRef(initial.scroll);
  const [pages, setPages] = useState(initial.pages);
  const pagesRef = useRef(pages);
  pagesRef.current = pages;
  const [refresh, setRefresh] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const generation = useRef(0);
  const acknowledged = useRef(new Set<string>());
  useEffect(() => {
    saveAttentionView(scope, {
      pages,
      scroll: scrollPosition.current,
    });
  }, [scope, pages]);
  useEffect(() => {
    const el = root.current?.closest(".space-dialog-body");
    if (!el) return;
    const frame = requestAnimationFrame(() => {
      el.scrollTop = initialScope.current === scope ? initial.scroll : 0;
      scrollPosition.current = el.scrollTop;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Parent layout may already change before passive unmount cleanup. Retain
    // the last observed position rather than reading a now-collapsed scroller.
    const save = () =>
      saveAttentionView(scope, { pages: pagesRef.current, scroll: scrollPosition.current });
    const schedule = () => {
      scrollPosition.current = el.scrollTop;
      clearTimeout(timer);
      timer = setTimeout(save, 200);
    };
    el.addEventListener("scroll", schedule, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      el.removeEventListener("scroll", schedule);
      save();
    };
  }, [scope, initial]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Refresh is an explicit finite user-triggered read.
  useEffect(() => {
    let live = true;
    const controller = new AbortController();
    const epoch = ++generation.current;
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
      const requests = scopes.flatMap(([id, revision, projects]) =>
        projects.map(([projectId, copy, repository]) => ({
          id,
          revision,
          projectId,
          copy,
          repository,
        })),
      );
      let next = 0;
      await Promise.all(
        Array.from({ length: Math.min(2, requests.length) }, async () => {
          while (live && next < requests.length) {
            const { id, revision, projectId, copy, repository } = requests[next++]!;
            const key = JSON.stringify([id, revision, projectId, copy, repository]);
            try {
              const old = pagesRef.current[key];
              const page = await api<SpaceActivityPage>(`/team/spaces/${id}/activity`, {
                method: "POST",
                signal: controller.signal,
                body: {
                  projectId,
                  ...(old?.versions
                    ? { known: { repositoryId: old.repositoryId, versions: old.versions } }
                    : {}),
                },
              });
              if (live && generation.current === epoch)
                setPages((current) => {
                  const merged = mergeActivityPage(current[key], page);
                  return {
                    ...current,
                    [key]: {
                      ...merged,
                      items: merged.items.map((source) => ({
                        ...source,
                        attention: source.attention?.map((n) =>
                          acknowledged.current.has(readKey(merged, source.key, n.version))
                            ? { ...n, read: true }
                            : n,
                        ),
                      })),
                    },
                  };
                });
            } catch (e) {
              if (live) {
                if (e instanceof ApiError && [401, 403, 404].includes(e.status)) {
                  setPages((old) =>
                    Object.fromEntries(Object.entries(old).filter(([k]) => k !== key)),
                  );
                  setTarget((old) =>
                    old?.space.id === id && old.source.projectId === projectId ? null : old,
                  );
                }
                setError(messageOf(e));
              }
            }
          }
        }),
      );
      if (live && generation.current === epoch) setBusy(false);
    })();
    return () => {
      live = false;
      controller.abort();
    };
  }, [scope, refresh]);
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
    <div ref={root} className="github-attention">
      <div className="activity-attention-heading">
        <strong>GitHub</strong>
        <button
          className="icon-button"
          type="button"
          aria-label="Обновить события GitHub"
          disabled={busy}
          onClick={() => setRefresh((v) => v + 1)}
        >
          <Icon name="refresh" />
        </button>
      </div>
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
                    for (const notice of n.notices)
                      acknowledged.current.add(readKey(n.page, n.source.key, notice.version));
                    while (acknowledged.current.size > 2000)
                      acknowledged.current.delete(acknowledged.current.values().next().value!);
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
    </div>
  );
}
