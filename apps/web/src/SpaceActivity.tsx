import type {
  ActivityGptHandoff,
  CollaborationSpace,
  GitHubActivitySource,
  SpaceActivityPage,
} from "@codex-web/shared";
import { useEffect, useRef, useState } from "react";
import { ActivityDiscussion } from "./ActivityDiscussion";
import { accountSessionStorage as storage } from "./accountStorage";
import { api, messageOf } from "./api";
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
  const [pages, setPages] = useState<SpaceActivityPage[]>([]),
    [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false),
    [refresh, setRefresh] = useState(0);
  const [project, setProject] = useState(""),
    [author, setAuthor] = useState(""),
    [limit, setLimit] = useState(20);
  const [opening, setOpening] = useState(""),
    [openError, setOpenError] = useState("");
  const generation = useRef(0);
  const [sources, setSources] = useState<Record<string, string>>({});
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
    setPages([]);
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
            body: { projectId },
          });
          if (generation.current === run) setPages((old) => [...old, page]);
        } catch (error) {
          if (generation.current === run)
            setErrors((old) => ({ ...old, [projectId]: messageOf(error) }));
        }
      }
      if (generation.current === run) setBusy(false);
    })();
    return () => {
      generation.current++;
    };
  }, [scope]);
  const entries: Entry[] = pages
    .flatMap((p) => {
      const current = eligible.find((v) => v.id === p.projectId);
      return current
        ? p.items.map((v) => ({ ...v, projectId: p.projectId, projectName: current.name }))
        : [];
    })
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || a.key.localeCompare(b.key));
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
  const open = async (entry: Entry) => {
    const run = generation.current,
      key = entry.projectId + entry.key;
    // Open synchronously for mobile popup rules; no source is exposed until authorization completes.
    const popup = window.open("about:blank", "_blank");
    if (popup) popup.opener = null;
    setOpening(key);
    setOpenError("");
    try {
      const checked = await api<SpaceActivityPage>(`/team/spaces/${space.id}/activity`, {
        method: "POST",
        body: { projectId: entry.projectId, source: entry.key },
      });
      const item = checked.items.find((v) => v.key === entry.key);
      if (run !== generation.current || !item) {
        popup?.close();
        return;
      }
      if (popup) popup.location.replace(item.url);
      else setOpenError("Разреши открытие новой вкладки и нажми ещё раз.");
    } catch (error) {
      popup?.close();
      if (run === generation.current) setOpenError(messageOf(error));
    } finally {
      if (run === generation.current) setOpening("");
    }
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
      <div className="activity-feed shared-scroll" aria-busy={busy}>
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
          const groupId = first.projectId + first.key;
          const selected = batch.find((v) => v.key === sources[groupId]) ?? first;
          const page = pages.find((p) => p.projectId === first.projectId)!;
          return (
            <div className="activity-group" key={first.projectId + first.key}>
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
                  {batch.length > 1 ? (
                    <details>
                      <summary>Все коммиты · {batch.length}</summary>
                      <ul>
                        {batch.map((v) => (
                          <li key={v.key}>
                            <button type="button" disabled={!!opening} onClick={() => void open(v)}>
                              <code>{v.sha!.slice(0, 7)}</code>
                              <span>{v.title}</span>
                              <Icon name="external" size={14} />
                            </button>
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : (
                    <button
                      className="activity-open"
                      type="button"
                      disabled={!!opening}
                      onClick={() => void open(first)}
                    >
                      {first.kind === "commit" ? first.sha!.slice(0, 7) : "Открыть в GitHub"}
                      <Icon name="external" size={14} />
                    </button>
                  )}
                  <button
                    type="button"
                    className="activity-open"
                    disabled={!!opening}
                    onClick={() => void discuss(batch)}
                  >
                    <Icon name="chat" size={15} />
                    {opening === "discuss" ? "Готовим контекст…" : "Обсудить в GPT"}
                  </button>
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
                    key={selected.key}
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
    </section>
  );
}
