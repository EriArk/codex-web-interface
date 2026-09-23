import type {
  ActivityGptHandoff,
  CollaborationSpace,
  GitHubActivitySource,
  SpaceActivityPage,
} from "@codex-web/shared";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ActivityDiscussion } from "./ActivityDiscussion";
import { type ActivitySourceTarget, ActivitySourceWindow } from "./ActivitySourceWindow";
import { accountSessionStorage as storage } from "./accountStorage";
import {
  activityScope,
  mergeActivityPage,
  readActivityView,
  saveActivityView,
} from "./activityCache";
import { ApiError, api, messageOf } from "./api";
import { IntakeButton } from "./IntakeWindow";
import { Icon } from "./icons";
import "./space-activity.css";

type Entry = GitHubActivitySource & { projectId: string; projectName: string };
function groups(items: Entry[]) {
  const result: Entry[][] = [];
  for (const item of items) {
    const last = result.at(-1),
      first = last?.[0];
    if (
      first &&
      item.kind === "commit" &&
      first.kind === "commit" &&
      item.author &&
      first.author?.id === item.author.id &&
      first.projectId === item.projectId &&
      first.at.slice(0, 10) === item.at.slice(0, 10) &&
      Date.parse(first.at) - Date.parse(item.at) <= 30 * 60000
    )
      last!.push(item);
    else result.push([item]);
  }
  return result;
}
const date = (v: string) => new Date(v).toLocaleDateString("ru", { day: "numeric", month: "long" });
const time = (v: string) =>
  new Date(v).toLocaleTimeString("ru", { hour: "2-digit", minute: "2-digit" });
const label = (v: Entry) =>
  v.kind === "commit"
    ? "Коммит"
    : v.kind === "pr"
      ? `PR #${v.number} · ${v.state === "merged" ? "Объединён" : v.state === "closed" ? "Закрыт" : "Открыт"}`
      : `Issue #${v.number} · ${v.state === "closed" ? "Закрыта" : "Открыта"}`;

export function SpaceActivity({
  space,
  onProject,
  onDiscuss,
}: {
  space: CollaborationSpace;
  onProject: (id: string) => void;
  onDiscuss: (handoff: ActivityGptHandoff) => void;
}) {
  const cacheScope = activityScope(space);
  const [initial] = useState(() => readActivityView(cacheScope));
  const [pages, setPages] = useState<SpaceActivityPage[]>(initial.pages),
    [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(!initial.pages.length),
    [refresh, setRefresh] = useState(0);
  const [project, setProject] = useState(initial.project),
    [author, setAuthor] = useState(initial.author),
    [limit, setLimit] = useState(initial.limit);
  const [opening, setOpening] = useState(""),
    [openError, setOpenError] = useState("");
  const generation = useRef(0);
  const [sources, setSources] = useState<Record<string, string>>(initial.sources);
  const [expanded, setExpanded] = useState(initial.expanded);
  const groupKeys = useRef(initial.groups),
    feed = useRef<HTMLDivElement>(null),
    scroll = useRef(initial.scroll);
  const [target, setTarget] = useState<ActivitySourceTarget | null>(null);
  const pagesRef = useRef(pages);
  pagesRef.current = pages;
  const view = useRef(initial);
  view.current = {
    pages,
    project,
    author,
    limit,
    sources,
    expanded,
    groups: groupKeys.current,
    scroll: scroll.current,
  };
  useEffect(() => {
    saveActivityView(cacheScope, {
      pages,
      project,
      author,
      limit,
      sources,
      expanded,
      groups: groupKeys.current,
      scroll: scroll.current,
    });
  }, [cacheScope, pages, project, author, limit, sources, expanded]);
  useEffect(
    () => () => saveActivityView(cacheScope, { ...view.current, scroll: scroll.current }),
    [cacheScope],
  );
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (feed.current) feed.current.scrollTop = initial.scroll;
    });
    return () => cancelAnimationFrame(frame);
  }, [initial]);
  const anchor = useRef<{ key: string; offset: number; top: number } | null>(null);
  const capture = useCallback(() => {
    const el = feed.current;
    if (!el) return;
    const row = [...el.querySelectorAll<HTMLElement>("[data-activity-key]")].find(
      (v) => v.getBoundingClientRect().bottom > el.getBoundingClientRect().top,
    );
    anchor.current = row
      ? {
          key: row.dataset.activityKey!,
          offset: row.getBoundingClientRect().top - el.getBoundingClientRect().top,
          top: el.scrollTop,
        }
      : null;
  }, []);
  useLayoutEffect(() => {
    const el = feed.current,
      a = anchor.current;
    anchor.current = null;
    if (!el || !a || a.top < 8) return;
    const row = [...el.querySelectorAll<HTMLElement>("[data-activity-key]")].find(
      (v) => v.dataset.activityKey === a.key,
    );
    if (row)
      el.scrollTop += row.getBoundingClientRect().top - el.getBoundingClientRect().top - a.offset;
  });
  const eligible = space.projects.filter((p) => p.access !== "none");
  const scope = JSON.stringify([
    space.id,
    space.revision,
    eligible.map((p) => [p.id, p.personalProjectId]),
    refresh,
  ]);
  useEffect(() => {
    const [spaceId, , projects] = JSON.parse(scope) as [
      string,
      number,
      [string, string | undefined][],
      number,
    ];
    const run = ++generation.current;
    setErrors({});
    setBusy(true);
    setOpenError("");
    void (async () => {
      // Serial, finite reads only while opened. Filters never trigger native reads.
      for (const [projectId, copy] of projects) {
        if (!copy) continue;
        if (generation.current !== run) return;
        try {
          const page = await api<SpaceActivityPage>(`/team/spaces/${spaceId}/activity`, {
            method: "POST",
            body: {
              projectId,
              ...(pagesRef.current.find((p) => p.projectId === projectId)?.versions
                ? {
                    known: {
                      repositoryId: pagesRef.current.find((p) => p.projectId === projectId)!
                        .repositoryId,
                      versions: pagesRef.current.find((p) => p.projectId === projectId)!.versions,
                    },
                  }
                : {}),
            },
          });
          if (generation.current === run) {
            capture();
            setPages((old) => [
              ...old.filter((p) => p.projectId !== projectId),
              mergeActivityPage(
                old.find((p) => p.projectId === projectId),
                page,
              ),
            ]);
          }
        } catch (error) {
          if (generation.current === run) {
            setErrors((old) => ({ ...old, [projectId]: messageOf(error) }));
            if (
              error instanceof ApiError &&
              (error.status === 403 ||
                error.status === 404 ||
                [
                  "GITHUB_WORK_ACCESS",
                  "GITHUB_WORK_LOGIN",
                  "GITHUB_WORK_IDENTITY_CHANGED",
                  "GITHUB_WORK_REPOSITORY",
                  "ACTIVITY_COPY_REQUIRED",
                ].includes(error.code))
            )
              setPages((old) => old.filter((p) => p.projectId !== projectId));
          }
        }
      }
      if (generation.current === run) setBusy(false);
    })();
    return () => {
      generation.current++;
    };
  }, [scope, capture]);
  const entries: Entry[] = pages
    .flatMap((p) => {
      const current = eligible.find((v) => v.id === p.projectId);
      return current
        ? p.items.map((v) => ({ ...v, projectId: p.projectId, projectName: current.name }))
        : [];
    })
    .sort(
      (a, b) =>
        Date.parse(b.at) - Date.parse(a.at) ||
        a.key.localeCompare(b.key) ||
        a.projectId.localeCompare(b.projectId),
    );
  const authors = [
    ...new Map(
      entries.filter((e) => e.author).map((e) => [String(e.author!.id), e.author!.login]),
    ).entries(),
  ];
  const filtered = groups(
    entries.filter(
      (e) => (!project || e.projectId === project) && (!author || String(e.author?.id) === author),
    ),
  );
  const open = (entry: Entry) => {
    const page = pages.find((p) => p.projectId === entry.projectId);
    if (page)
      setTarget({ projectId: entry.projectId, repositoryId: page.repositoryId, source: entry });
  };
  const discuss = async (batch: Entry[]) => {
    if (opening) return;
    const run = generation.current;
    setOpening("discuss");
    setOpenError("");
    try {
      const ownProject = eligible.find((p) => p.id === batch[0]!.projectId)?.personalProjectId;
      const storageKey = `project-activity-handoff:${ownProject}`;
      const pending = JSON.parse(
        storage.getItem(storageKey) ?? "null",
      ) as ActivityGptHandoff | null;
      // Reopening the same discussion retains a potentially unacknowledged send.
      const reuse =
        pending?.spaceId === space.id &&
        pending.sharedProjectId === batch[0]!.projectId &&
        JSON.stringify(pending.sourceKeys) === JSON.stringify(batch.map((v) => v.key));
      const handoff = reuse
        ? await api<ActivityGptHandoff>(`/team/activity-handoffs/${encodeURIComponent(pending.id)}`)
        : await api<ActivityGptHandoff>(`/team/spaces/${space.id}/activity/discuss`, {
            method: "POST",
            key: crypto.randomUUID(),
            body: { projectId: batch[0]!.projectId, sources: batch.map((v) => v.key) },
          });
      if (generation.current === run) {
        storage.setItem(storageKey, JSON.stringify(handoff));
        onDiscuss(handoff);
      }
    } catch (error) {
      if (generation.current === run) setOpenError(messageOf(error));
    } finally {
      if (generation.current === run) setOpening("");
    }
  };
  const usedGroupKeys = new Set<string>();
  return (
    <section className="space-activity" aria-label="Активность пространства">
      <div className="activity-toolbar">
        <label>
          <span>Проект</span>
          <select
            aria-label="Проект активности"
            value={project}
            onChange={(e) => {
              setProject(e.target.value);
              setLimit(20);
            }}
          >
            <option value="">Все проекты</option>
            {eligible.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Автор · GitHub</span>
          <select
            aria-label="Автор активности"
            value={author}
            onChange={(e) => {
              setAuthor(e.target.value);
              setLimit(20);
            }}
          >
            <option value="">Все авторы</option>
            {authors.map(([id, name]) => (
              <option key={id} value={id}>
                @{name}
              </option>
            ))}
          </select>
        </label>
        <button
          className="icon-button"
          type="button"
          aria-label="Обновить активность"
          disabled={busy}
          onClick={() => setRefresh((v) => v + 1)}
        >
          <Icon name="refresh" size={18} />
        </button>
      </div>
      <div
        ref={feed}
        className="activity-feed shared-scroll"
        aria-busy={busy}
        onScroll={(e) => {
          scroll.current = e.currentTarget.scrollTop;
        }}
      >
        {!entries.length && busy && <p className="activity-empty">Загружаем события…</p>}
        {eligible
          .filter((p) => !project || p.id === project)
          .map((p) =>
            !p.personalProjectId ? (
              <div className="activity-empty" key={p.id}>
                <strong>{p.name}</strong>
                <p>Подключи свою рабочую копию для просмотра GitHub.</p>
                <button type="button" className="secondary" onClick={() => onProject(p.id)}>
                  Подключить
                </button>
              </div>
            ) : errors[p.id] ? (
              <p className="activity-empty" role="status" key={p.id}>
                {p.name}: {errors[p.id]}
              </p>
            ) : null,
          )}
        {!busy && !filtered.length && !Object.keys(errors).length && (
          <p className="activity-empty">Пока нет событий по этому выбору.</p>
        )}
        {openError && <p role="status">{openError}</p>}
        {filtered.slice(0, limit).map((batch, index) => {
          const first = batch[0]!,
            day = date(first.at);
          const groupId =
            batch
              .map((v) => groupKeys.current[v.projectId + v.key])
              .find((key) => key && !usedGroupKeys.has(key)) ?? first.projectId + first.key;
          usedGroupKeys.add(groupId);
          for (const v of batch) groupKeys.current[v.projectId + v.key] = groupId;
          const selected =
            batch.find(
              (v) => v.key === (sources[groupId] ?? groupId.slice(first.projectId.length)),
            ) ?? first;
          const page = pages.find((p) => p.projectId === first.projectId)!;
          return (
            <div className="activity-group" key={groupId} data-activity-key={groupId}>
              {(index === 0 || date(filtered[index - 1]![0]!.at) !== day) && (
                <h3 className="activity-date">{day}</h3>
              )}
              <article className="activity-card">
                <span className="activity-symbol">
                  <Icon
                    name={
                      first.kind === "commit" ? "branch" : first.kind === "pr" ? "branch" : "plan"
                    }
                    size={19}
                  />
                </span>
                <div className="activity-content">
                  <div className="activity-meta">
                    <strong>{first.author ? "@" + first.author.login : first.authorName}</strong>
                    <span>{first.projectName}</span>
                    <time dateTime={first.at} title={new Date(first.at).toLocaleString("ru")}>
                      {time(first.at)}
                    </time>
                  </div>
                  <small className="activity-kind">
                    {batch.length > 1 ? `${batch.length} коммита` : label(first)}
                  </small>
                  <h4>{first.title}</h4>
                  <div className="activity-primary-actions">
                    {batch.length > 1 ? (
                      <details
                        open={!!expanded[groupId]}
                        onToggle={(e) => {
                          const open = e.currentTarget.open;
                          setExpanded((old) =>
                            old[groupId] === open ? old : { ...old, [groupId]: open },
                          );
                        }}
                      >
                        <summary>Все коммиты · {batch.length}</summary>
                        <ul>
                          {batch.map((v) => (
                            <li key={v.key}>
                              <button
                                className="secondary activity-commit-button"
                                type="button"
                                disabled={!!opening}
                                onClick={() => void open(v)}
                              >
                                <code>{v.sha!.slice(0, 7)}</code>
                                <span>{v.title}</span>
                                <Icon name="folder" size={14} />
                              </button>
                            </li>
                          ))}
                        </ul>
                      </details>
                    ) : (
                      <button
                        className="secondary activity-open"
                        type="button"
                        disabled={!!opening}
                        onClick={() => void open(first)}
                      >
                        {first.kind === "commit"
                          ? "Открыть коммит"
                          : first.kind === "pr"
                            ? "Открыть PR"
                            : "Открыть Issue"}
                      </button>
                    )}
                    <button
                      type="button"
                      className="secondary activity-open"
                      aria-label="Обсудить в GPT"
                      disabled={!!opening}
                      onClick={() => void discuss(batch)}
                    >
                      <Icon name="chat" size={15} />
                      {opening === "discuss" ? "Готовим…" : "В GPT"}
                    </button>
                    {eligible.find((p) => p.id === first.projectId)?.personalProjectId && (
                      <IntakeButton
                        projectId={
                          eligible.find((p) => p.id === first.projectId)!.personalProjectId!
                        }
                        name={first.projectName}
                        sources={[selected.url]}
                        draftScope={`activity:${page.repositoryId}:${selected.key}`}
                        label="В Codex"
                        ariaLabel="Изучить в Codex"
                        className="secondary activity-open"
                        onWork={() =>
                          onProject(
                            eligible.find((p) => p.id === first.projectId)!.personalProjectId!,
                          )
                        }
                      />
                    )}
                  </div>
                  {batch.length > 1 && (
                    <label className="activity-source-picker">
                      Обсуждение коммита
                      <select
                        aria-label="Коммит для обсуждения"
                        value={selected.key}
                        onChange={(e) => setSources((v) => ({ ...v, [groupId]: e.target.value }))}
                      >
                        {batch.map((v) => (
                          <option key={v.key} value={v.key}>
                            {v.sha!.slice(0, 7)} · {v.title}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <ActivityDiscussion
                    key={`${page.repositoryId}:${selected.key}`}
                    space={space}
                    projectId={selected.projectId}
                    repositoryId={page.repositoryId}
                    source={selected}
                    summary={page.social?.[selected.key] ?? { replies: 0, reactions: [] }}
                    onSummary={(summary) =>
                      setPages((old) =>
                        old.map((p) =>
                          p.projectId === selected.projectId
                            ? { ...p, social: { ...p.social, [selected.key]: summary } }
                            : p,
                        ),
                      )
                    }
                  />
                </div>
              </article>
            </div>
          );
        })}
        {filtered.length > limit && (
          <button
            className="secondary activity-more"
            type="button"
            onClick={() => setLimit((n) => n + 20)}
          >
            Показать ещё
          </button>
        )}
        {!!filtered.length && (
          <p className="activity-footnote">
            Коммиты основной ветки и последние изменения Issues / PR. Указан автор исходного
            объекта.
          </p>
        )}
      </div>
      {target && (
        <ActivitySourceWindow space={space} target={target} onClose={() => setTarget(null)} />
      )}
    </section>
  );
}
