import type {
  ActivityDiscussionPage,
  ActivityReaction,
  ActivitySocialSummary,
  CollaborationSpace,
  GitHubActivitySource,
} from "@codex-web/shared";
import { useEffect, useRef, useState } from "react";
import { ActivitySourceWindow } from "./ActivitySourceWindow";
import { AutoTextarea } from "./AutoTextarea";
import { pageWorkspace, accountLocalStorage as storage } from "./accountStorage";
import { api, messageOf } from "./api";
import { useSharedAction } from "./sharedRequests";

const reactions: [ActivityReaction, string, string][] = [
  ["like", "👍", "Нравится"],
  ["seen", "👀", "Смотрю"],
  ["thanks", "🙏", "Спасибо"],
  ["question", "❓", "Есть вопрос"],
];
type Scope = { projectId: string; repositoryId: number; source: string };
/** Preserve the exact unacknowledged operation across close/reopen; clear only on acceptance. */
async function mutate<T>(path: string, body: unknown) {
  const scope = body as Scope;
  const name = `activity-request:${path}:${scope.projectId}:${scope.repositoryId}:${scope.source}`,
    signature = JSON.stringify(body);
  const old = JSON.parse(storage.getItem(name) ?? "null");
  const value = old?.signature === signature ? old : { signature, key: crypto.randomUUID() };
  storage.setItem(name, JSON.stringify(value));
  if (storage.getItem(name) !== JSON.stringify(value))
    throw Error("Не удалось сохранить подтверждение на устройстве.");
  const result = await api<T>(path, { method: "POST", body, key: value.key });
  if (storage.getItem(name) === JSON.stringify(value)) storage.removeItem(name);
  return result;
}
export function ActivityDiscussion({
  space,
  projectId,
  repositoryId,
  source,
  summary,
  onSummary,
  notification,
  onRead,
}: {
  space: CollaborationSpace;
  projectId: string;
  repositoryId: number;
  source: GitHubActivitySource;
  summary: ActivitySocialSummary;
  onSummary: (s: ActivitySocialSummary) => void;
  notification?: ActivityDiscussionPage;
  onRead?: () => void;
}) {
  const [expanded, setExpanded] = useState(!!notification),
    [page, setPage] = useState<ActivityDiscussionPage | null>(notification ?? null);
  const visible = useRef(!!notification);
  const scope: Scope = { projectId, repositoryId, source: source.key },
    path = `/team/spaces/${space.id}/activity`;
  const draftKey = `activity-draft:${space.id}:${projectId}:${repositoryId}:${source.key}`;
  const [draft, setDraft] = useState(() => {
    try {
      return (
        JSON.parse(storage.getItem(draftKey) ?? "null") ?? { text: "", recipientId: "", replyTo: 0 }
      );
    } catch {
      return { text: "", recipientId: "", replyTo: 0 };
    }
  });
  const action = useSharedAction();
  useEffect(() => {
    try {
      if (draft.text || draft.recipientId) storage.setItem(draftKey, JSON.stringify(draft));
      else storage.removeItem(draftKey);
    } catch {
      /* Keep the mounted draft; mutation requires a durable receipt before dispatch. */
    }
  }, [draft, draftKey]);
  const eligible = space.projects.find((p) => p.id === projectId);
  const recipients = space.members.filter(
    (m) =>
      m.id !== pageWorkspace &&
      (m.id === eligible?.ownerId || eligible?.grants.some((g) => g.userId === m.id)),
  );
  const load = async (before?: number) => {
    const next = await api<ActivityDiscussionPage>(path + "/replies", {
      method: "POST",
      body: { ...scope, ...(before ? { before } : {}) },
    });
    if (!action.active()) return;
    setPage((old) =>
      before && old ? { ...next, replies: [...next.replies, ...old.replies] } : next,
    );
    onSummary(next.summary);
    // Acknowledge only this actually loaded page, never all future replies.
    if (visible.current && !document.hidden && next.replies.length)
      await api(path + "/read", {
        method: "POST",
        body: { ...scope, seqs: next.replies.map((r) => r.seq) },
      })
        .then(() => onRead?.())
        .catch(() => {});
  };
  useEffect(() => {
    if (notification?.replies.length && !document.hidden)
      void api(path + "/read", {
        method: "POST",
        body: {
          projectId,
          repositoryId,
          source: source.key,
          seqs: notification.replies.map((r) => r.seq),
        },
      })
        .then(() => onRead?.())
        .catch(() => {});
  }, [notification, path, projectId, repositoryId, source.key, onRead]);
  return (
    <section className="activity-social" aria-label="Обсуждение события">
      <div className="activity-social-actions">
        {reactions.map(([kind, icon, label]) => {
          const value = summary.reactions.find((r) => r.kind === kind);
          return (
            <button
              key={kind}
              type="button"
              className="activity-reaction"
              aria-label={label}
              title={label}
              aria-pressed={!!value?.mine}
              disabled={action.busy}
              onClick={() =>
                void action.run(async () => {
                  const next = await mutate<ActivitySocialSummary>(path + "/react", {
                    ...scope,
                    kind: value?.mine ? null : kind,
                  });
                  if (action.active()) onSummary(next);
                })
              }
            >
              {icon}
              {value?.count ? <small>{value.count}</small> : null}
            </button>
          );
        })}
        <button
          type="button"
          className="secondary activity-open"
          aria-expanded={expanded}
          disabled={action.busy}
          onClick={() => {
            setExpanded(!expanded);
            visible.current = !expanded;
            if (!expanded) void action.run(() => load());
          }}
        >
          Обсуждение{summary.replies ? ` · ${summary.replies}` : ""}
        </button>
      </div>
      {expanded && (
        <div className="activity-discussion">
          <div className="activity-reply-toolbar">
            {page?.more && (
              <button
                className="secondary activity-open"
                type="button"
                disabled={action.busy}
                onClick={() => void action.run(() => load(page.replies[0]!.seq))}
              >
                Раньше
              </button>
            )}
            <button
              className="secondary activity-open"
              type="button"
              disabled={action.busy}
              onClick={() => void action.run(() => load())}
            >
              Обновить ответы
            </button>
          </div>
          {page?.replies.map((r) => (
            <article className="activity-reply" key={r.id}>
              <div className="activity-meta">
                <strong>{r.author.name}</strong>
                <time dateTime={new Date(r.at).toISOString()}>
                  {new Date(r.at).toLocaleString("ru", {
                    day: "numeric",
                    month: "short",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </time>
              </div>
              {r.recipient && (
                <small className="activity-kind">
                  {r.replyTo ? "В ответ" : "Для"}: {r.recipient.name}
                </small>
              )}
              <p>{r.text}</p>
              <button
                type="button"
                className="secondary activity-open"
                disabled={action.busy}
                onClick={() => setDraft({ ...draft, replyTo: r.seq, recipientId: r.author.id })}
              >
                Ответить
              </button>
            </article>
          ))}
          {page && !page.replies.length && (
            <small className="activity-kind">Здесь можно коротко обсудить это событие.</small>
          )}
          <form
            className="activity-reply-form"
            onSubmit={(e) => {
              e.preventDefault();
              void action.run(async () => {
                await mutate(path + "/reply", {
                  ...scope,
                  text: draft.text,
                  ...(draft.replyTo ? { replyTo: draft.replyTo } : {}),
                  ...(draft.recipientId ? { recipientId: draft.recipientId } : {}),
                });
                storage.removeItem(draftKey);
                if (action.active()) {
                  setDraft({ text: "", recipientId: "", replyTo: 0 });
                  await load();
                }
              });
            }}
          >
            <label className="activity-recipient">
              {draft.replyTo ? "Ответ участнику" : "Кому"}
              <select
                aria-label="Кому ответ"
                value={draft.recipientId}
                disabled={action.busy}
                onChange={(e) => setDraft({ ...draft, recipientId: e.target.value, replyTo: 0 })}
              >
                <option value="">В обсуждение</option>
                {space.members
                  .filter(
                    (m) => recipients.some((r) => r.id === m.id) || m.id === draft.recipientId,
                  )
                  .map((m) => (
                    <option value={m.id} key={m.id}>
                      {m.name}
                    </option>
                  ))}
              </select>
            </label>
            <AutoTextarea
              aria-label="Короткий ответ"
              rows={3}
              maxLength={2000}
              value={draft.text}
              disabled={action.busy}
              placeholder="Короткий ответ…"
              onChange={(e) => setDraft({ ...draft, text: e.target.value })}
            />
            <button
              className="secondary"
              type="submit"
              disabled={action.busy || !draft.text.trim()}
            >
              Отправить ответ
            </button>
          </form>
        </div>
      )}
      {action.error && <p role="status">{action.error}</p>}
    </section>
  );
}

export function ActivityAttentionWindow({
  space,
  seq,
  onRead,
}: {
  space: CollaborationSpace;
  seq: number;
  onRead: () => void;
}) {
  const [page, setPage] = useState<ActivityDiscussionPage | null>(null),
    [error, setError] = useState("");
  const [sourceOpen, setSourceOpen] = useState(false);
  useEffect(() => {
    let live = true;
    setPage(null);
    setError("");
    void api<ActivityDiscussionPage>(`/team/spaces/${space.id}/activity/attention`, {
      method: "POST",
      body: { seq },
    })
      .then((value) => {
        if (live) setPage(value);
      })
      .catch((e) => {
        if (live) setError(messageOf(e));
      });
    return () => {
      live = false;
    };
  }, [space.id, seq]);
  return (
    <div className="activity-feed shared-scroll">
      {page &&
        space.projects.some(
          (p) => p.id === page.projectId && p.access !== "none" && p.personalProjectId,
        ) && (
          <>
            <h3>{page.source.title}</h3>
            <button type="button" className="secondary" onClick={() => setSourceOpen(true)}>
              Открыть событие
            </button>
            {sourceOpen && (
              <ActivitySourceWindow
                space={space}
                target={{
                  projectId: page.projectId,
                  repositoryId: page.repositoryId,
                  source: page.source,
                }}
                onClose={() => setSourceOpen(false)}
              />
            )}
            <ActivityDiscussion
              key={page.source.key}
              space={space}
              projectId={page.projectId}
              repositoryId={page.repositoryId}
              source={page.source}
              summary={page.summary}
              onSummary={(summary) => setPage((p) => (p ? { ...p, summary } : p))}
              notification={page}
              onRead={onRead}
            />
          </>
        )}
      {error && <p role="status">{error}</p>}
    </div>
  );
}
