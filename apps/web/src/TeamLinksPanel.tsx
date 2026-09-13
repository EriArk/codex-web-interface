import type { SharedProject, TeamContact, TeamLink, TeamLinkPolicy } from "@codex-web/shared";
import { teamLinkProposalSchema } from "@codex-web/shared";
import { useState } from "react";
import { accountLocalStorage as storage } from "./accountStorage";
import { ApiError, api } from "./api";
import { sharedMutation, useSharedAction } from "./sharedRequests";
import { useSharedResource } from "./sharedResources";
import { TeamContactPicker } from "./TeamContactPicker";

export function TeamLinkPolicyView({ policy }: { policy: TeamLinkPolicy }) {
  return (
    <p className="muted">
      {policy.direction === "both" ? "Оба направления" : "Из первого проекта во второй"} ·{" "}
      {policy.consult ? "Консультации" : "Без консультаций"}
      {policy.bridge ? " · Обсуждения Bridge" : ""} ·{" "}
      {policy.automatic ? "Автоконсультации" : "Только после подтверждения"} · Глубина{" "}
      {policy.depth}
    </p>
  );
}
export function TeamLinkInvitations({
  revision,
  refresh,
}: {
  revision: number;
  refresh: () => void;
}) {
  const data = useSharedResource<{ items: TeamLink[] }>("/team/link-invitations", revision);
  return (
    <>
      {data.value?.items.map((link) => (
        <LinkInvitation key={link.id} link={link} refresh={refresh} />
      ))}
      {data.error && <p role="alert">{data.error}</p>}
    </>
  );
}
function LinkInvitation({ link, refresh }: { link: TeamLink; refresh: () => void }) {
  const [selected, setSelected] = useState(""),
    [offset, setOffset] = useState(0);
  const projects = useSharedResource<{ items: SharedProject[]; nextOffset: number | null }>(
    "/team/projects?offset=" + offset,
  );
  const { run, error, busy } = useSharedAction();
  const answer = (accept: boolean) =>
    void run(() =>
      sharedMutation(`/team/links/${link.id}/answer`, "POST", {
        revision: link.revision,
        accept,
        ...(accept ? { projectId: selected } : {}),
      }),
    ).then((value) => {
      if (value) refresh();
    });
  return (
    <article className="shared-card shared-form">
      <h3>Связь с «{link.source.title}»</h3>
      <p>{link.source.ownerName} предлагает связать проекты.</p>
      <p>{link.purpose}</p>
      <TeamLinkPolicyView policy={link.policy} />
      <label>
        Мой проект для связи
        <select
          aria-label="Мой проект для связи"
          disabled={busy}
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
        >
          <option value="">Выбери свой проект</option>
          {projects.value?.items
            .filter((p) => p.role === "owner" && !p.archived && p.id !== link.source.id)
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
        </select>
      </label>
      <p className="muted">
        После принятия другая сторона увидит название выбранного проекта. Личные материалы и чаты
        остаются у тебя.
      </p>
      <div className="shared-actions">
        {offset > 0 && (
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => setOffset(Math.max(0, offset - 30))}
          >
            Предыдущие проекты
          </button>
        )}
        {projects.value?.nextOffset != null && (
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => setOffset(projects.value!.nextOffset!)}
          >
            Ещё проекты
          </button>
        )}
      </div>
      {(error || projects.error) && <p role="alert">{error || projects.error}</p>}
      <div className="shared-actions">
        <button
          type="button"
          className="primary"
          disabled={busy || !selected}
          onClick={() => answer(true)}
        >
          Принять связь
        </button>
        <button type="button" className="secondary" disabled={busy} onClick={() => answer(false)}>
          Отклонить связь
        </button>
      </div>
    </article>
  );
}
export function TeamLinksPanel({
  project,
  revision,
  refresh,
}: {
  project: SharedProject;
  revision: number;
  refresh: () => void;
}) {
  const pendingKey = "workspace-link-proposal:" + project.id;
  const [restored] = useState(() => {
    try {
      const v = JSON.parse(storage.getItem(pendingKey) ?? "null");
      if (
        v &&
        /^[a-f0-9-]{36}$/.test(v.id) &&
        v.body?.projectId === project.id &&
        v.contact?.id === v.body?.userId &&
        typeof v.contact?.name === "string"
      )
        return {
          id: String(v.id),
          body: teamLinkProposalSchema.parse(v.body),
          contact: v.contact as TeamContact,
        };
    } catch {}
    return null;
  });
  const [contact, setContact] = useState<TeamContact | null>(restored?.contact ?? null),
    [purpose, setPurpose] = useState(restored?.body.purpose ?? ""),
    [creating, setCreating] = useState(!!restored),
    [offset, setOffset] = useState(0),
    [revoke, setRevoke] = useState<TeamLink | null>(null);
  const [policy, setPolicy] = useState<TeamLinkPolicy>(
    restored?.body.policy ?? {
      direction: "both",
      consult: true,
      bridge: true,
      automatic: false,
      depth: 3,
    },
  );
  const data = useSharedResource<{ items: TeamLink[]; nextOffset: number | null }>(
    `/team/projects/${project.id}/links?offset=${offset}`,
    revision,
  );
  const { run, error, busy, active } = useSharedAction();
  const [proposal, setProposal] = useState<{ id: string; body: unknown } | null>(restored);
  const submit = () => {
    const attempt = proposal ?? {
      id: crypto.randomUUID(),
      body: { projectId: project.id, userId: contact?.id, purpose, policy },
    };
    void run(async () => {
      storage.setItem(pendingKey, JSON.stringify({ ...attempt, contact }));
      setProposal(attempt);
      try {
        const result = await api<TeamLink>("/team/links/" + attempt.id, {
          method: "PUT",
          body: attempt.body,
        });
        storage.removeItem(pendingKey);
        return result;
      } catch (e) {
        if (e instanceof ApiError && e.status < 500) {
          storage.removeItem(pendingKey);
          if (active()) setProposal(null);
        }
        throw e;
      }
    }).then((v) => {
      if (v) {
        setProposal(null);
        setCreating(false);
        setPurpose("");
        refresh();
      }
    });
  };
  return (
    <div className="shared-form">
      <TeamLinkInvitations revision={revision} refresh={refresh} />
      <h3>Связанные проекты</h3>
      {(data.error || error) && <p role="alert">{data.error || error}</p>}
      {project.role === "owner" && !project.archived && !creating && (
        <button type="button" className="primary" onClick={() => setCreating(true)}>
          Предложить связь
        </button>
      )}
      {creating && (
        <section className="shared-card shared-form">
          <TeamContactPicker value={contact} onChange={setContact} disabled={busy || !!proposal} />
          <label>
            Для чего связываем проекты
            <textarea
              value={purpose}
              maxLength={1000}
              disabled={busy || !!proposal}
              onChange={(e) => setPurpose(e.target.value)}
            />
          </label>
          <label>
            Направление
            <select
              value={policy.direction}
              disabled={busy || !!proposal}
              onChange={(e) =>
                setPolicy({ ...policy, direction: e.target.value as TeamLinkPolicy["direction"] })
              }
            >
              <option value="both">В обе стороны</option>
              <option value="outgoing">От моего проекта к выбранному</option>
            </select>
          </label>
          {(
            [
              ["consult", "Консультации"],
              ["bridge", "Обсуждения Bridge"],
              ["automatic", "Автоматические консультации"],
            ] as const
          ).map(([key, label]) => (
            <label className="shared-check" key={key}>
              <input
                type="checkbox"
                checked={policy[key]}
                disabled={busy || !!proposal || (key === "automatic" && !policy.consult)}
                onChange={(e) =>
                  setPolicy({
                    ...policy,
                    [key]: e.target.checked,
                    ...(key === "consult" && !e.target.checked ? { automatic: false } : {}),
                  })
                }
              />
              {label}
            </label>
          ))}
          <label>
            Глубина обмена: {policy.depth}
            <input
              type="range"
              min={1}
              max={10}
              step={1}
              value={policy.depth}
              disabled={busy || !!proposal}
              onChange={(e) => setPolicy({ ...policy, depth: Number(e.target.value) })}
            />
          </label>
          <p className="muted">
            Каждый проект отвечает через аккаунт своего владельца. Выполнение работ требует
            отдельного запуска.
          </p>
          <div className="shared-actions">
            <button
              type="button"
              className="primary"
              disabled={busy || !contact || !purpose.trim()}
              onClick={submit}
            >
              {proposal ? "Повторить подтверждение" : "Отправить предложение"}
            </button>
            <button
              type="button"
              className="secondary"
              disabled={busy || !!proposal}
              onClick={() => setCreating(false)}
            >
              Отмена
            </button>
          </div>
        </section>
      )}
      {data.value?.items.map((link) => (
        <article className="shared-card" key={link.id}>
          <h3>
            {link.source.title} ↔ {link.target?.title ?? link.recipient.name}
          </h3>
          <p>{link.purpose}</p>
          <TeamLinkPolicyView policy={link.policy} />
          <small>
            {
              {
                pending: "Ждёт выбора проекта",
                accepted: "Принята",
                declined: "Отклонена",
                revoked: "Отозвана",
              }[link.state]
            }
          </small>
          {project.role === "owner" && (link.state === "pending" || link.state === "accepted") && (
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => setRevoke(link)}
            >
              Отозвать связь
            </button>
          )}
        </article>
      ))}
      {revoke && (
        <section className="shared-card" role="alert">
          <p>
            Отозвать связь «{revoke.source.title}» с «
            {revoke.target?.title ?? revoke.recipient.name}»? Новые консультации и передача ответов
            прекратятся. Уже сохранённые обсуждения останутся.
          </p>
          <div className="shared-actions">
            <button
              type="button"
              disabled={busy}
              className="danger"
              onClick={() =>
                void run(() =>
                  sharedMutation(`/team/links/${revoke.id}/revoke`, "POST", {
                    projectId: project.id,
                    revision: revoke.revision,
                  }),
                ).then((v) => {
                  if (v) {
                    setRevoke(null);
                    refresh();
                  }
                })
              }
            >
              Подтвердить отзыв связи
            </button>
            <button
              type="button"
              disabled={busy}
              className="secondary"
              onClick={() => setRevoke(null)}
            >
              Отмена
            </button>
          </div>
        </section>
      )}
      <div className="shared-actions">
        {offset > 0 && (
          <button
            type="button"
            className="secondary"
            onClick={() => setOffset(Math.max(0, offset - 30))}
          >
            Предыдущие связи
          </button>
        )}
        {data.value?.nextOffset != null && (
          <button
            type="button"
            className="secondary"
            onClick={() => setOffset(data.value!.nextOffset!)}
          >
            Ещё связи
          </button>
        )}
      </div>
    </div>
  );
}
