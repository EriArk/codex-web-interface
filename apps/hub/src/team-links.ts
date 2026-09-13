import { HubError, type TeamLink, teamLinkProposalSchema } from "@codex-web/shared";
import type { TeamProjects } from "./team-projects.js";

const missing = () => new HubError(404, "TEAM_LINK_MISSING", "Связь недоступна.");
const changed = () =>
  new HubError(409, "TEAM_LINK_CHANGED", "Связь или её владелец изменились. Обнови панель.");
/** Consent shares only the named project identity and bounded exchanges, never project membership. */
export class TeamLinks {
  constructor(readonly projects: TeamProjects) {}
  get db() {
    return this.projects.db;
  }
  raw(id: string): TeamLink {
    const row = this.db.prepare("SELECT value FROM team_links WHERE id=?").get(id);
    if (!row) throw missing();
    return JSON.parse(String(row.value));
  }
  private save(value: TeamLink) {
    this.db
      .prepare("UPDATE team_links SET state=?,value=? WHERE id=?")
      .run(value.state, JSON.stringify(value), value.id);
    return value;
  }
  private identity(actor: string, projectId: string) {
    const p = this.projects.access(actor, projectId, "owner");
    if (p.archived) throw changed();
    return {
      id: projectId,
      title: String(p.title),
      ownerId: actor,
      ownerName: this.projects.registry.user(actor).name,
    };
  }
  get(actor: string, id: string, projectId?: string) {
    this.projects.registry.active(actor);
    const v = this.raw(id);
    if (projectId) {
      this.projects.access(actor, projectId);
      if (v.source.id !== projectId && v.target?.id !== projectId) throw missing();
    } else if (
      v.recipient.id !== actor &&
      v.source.ownerId !== actor &&
      v.target?.ownerId !== actor
    )
      throw missing();
    return v;
  }
  page(actor: string, projectId: string, offset = 0) {
    this.projects.access(actor, projectId);
    const rows = this.db
      .prepare(
        "SELECT value FROM team_links WHERE sourceId=? OR targetId=? ORDER BY createdAt DESC,id LIMIT 31 OFFSET ?",
      )
      .all(projectId, projectId, offset);
    return {
      items: rows.slice(0, 30).map((r) => JSON.parse(String(r.value)) as TeamLink),
      nextOffset: rows.length > 30 ? offset + 30 : null,
    };
  }
  invitations(actor: string) {
    this.projects.registry.active(actor);
    return {
      items: this.db
        .prepare(
          "SELECT value FROM team_links WHERE recipientId=? AND state='pending' AND expires>? ORDER BY createdAt DESC,id LIMIT 100",
        )
        .all(actor, Date.now())
        .map((r) => JSON.parse(String(r.value)) as TeamLink),
    };
  }
  propose(actor: string, id: string, raw: unknown) {
    const input = teamLinkProposalSchema.parse(raw),
      source = this.identity(actor, input.projectId);
    if (this.db.prepare("SELECT 1 FROM team_links WHERE id=?").get(id))
      this.get(actor, id, input.projectId);
    const saved = this.projects.once(actor, "link.propose", id, input, () => {
      if (this.db.prepare("SELECT 1 FROM team_links WHERE id=?").get(id)) throw changed();
      const recipient = this.db
        .prepare("SELECT id,name FROM team_users WHERE id=? AND state='active'")
        .get(input.userId);
      if (!recipient) throw missing();
      if (
        Number(
          this.db
            .prepare(
              "SELECT COUNT(*) n FROM team_links WHERE sourceId=? AND state IN ('pending','accepted')",
            )
            .get(source.id)?.n,
        ) >= 100
      )
        throw new HubError(
          409,
          "TEAM_LINK_CAPACITY",
          "Сначала заверши или отзови прежние приглашения.",
        );
      const v: TeamLink = {
        id,
        source,
        target: null,
        recipient: { id: String(recipient.id), name: String(recipient.name) },
        purpose: input.purpose,
        policy: input.policy,
        state: "pending",
        revision: 1,
        createdAt: Date.now(),
        expires: Date.now() + 7 * 86400000,
      };
      this.db
        .prepare("INSERT INTO team_links VALUES(?,?,NULL,?,?,?,?,?)")
        .run(id, source.id, v.recipient.id, v.state, JSON.stringify(v), v.createdAt, v.expires);
      this.projects.changed(actor, source.id, "link.proposed");
      return { id };
    });
    return this.get(actor, saved.id, input.projectId);
  }
  answer(
    actor: string,
    id: string,
    key: string,
    input: { revision: number; accept: boolean; projectId?: string },
  ) {
    const v = this.get(actor, id);
    if (v.recipient.id !== actor) throw missing();
    if (input.accept && !input.projectId) throw changed();
    const target = input.accept ? this.identity(actor, input.projectId!) : null;
    const saved = this.projects.once(actor, "link.answer:" + id, key, input, () => {
      const value = this.get(actor, id);
      if (
        value.state !== "pending" ||
        value.revision !== input.revision ||
        value.expires <= Date.now()
      )
        throw changed();
      const source = this.identity(value.source.ownerId, value.source.id);
      if (
        target &&
        (target.id === source.id ||
          this.db
            .prepare(
              "SELECT 1 FROM team_links WHERE state='accepted' AND ((sourceId=? AND targetId=?) OR (sourceId=? AND targetId=?))",
            )
            .get(source.id, target.id, target.id, source.id))
      )
        throw new HubError(
          409,
          "TEAM_LINK_EXISTS",
          "Выбери другой проект или используй уже принятую связь.",
        );
      value.source = source;
      value.target = target;
      value.state = target ? "accepted" : "declined";
      value.revision++;
      this.save(value);
      this.db.prepare("UPDATE team_links SET targetId=? WHERE id=?").run(target?.id ?? null, id);
      this.projects.changed(actor, source.id, "link." + value.state);
      if (target) this.projects.changed(actor, target.id, "link.accepted");
      return { id };
    });
    return this.get(actor, saved.id);
  }
  revoke(actor: string, projectId: string, id: string, key: string, revision: number) {
    this.projects.access(actor, projectId, "owner");
    this.get(actor, id, projectId);
    this.projects.once(actor, "link.revoke:" + id, key, { projectId, revision }, () => {
      const v = this.get(actor, id, projectId);
      if (v.revision !== revision) throw changed();
      v.state = "revoked";
      v.revision++;
      this.save(v);
      this.projects.changed(actor, projectId, "link.revoked");
      return { id };
    });
    return this.get(actor, id, projectId);
  }
  /** Called again at native commit and return, not just when the user opens a panel. */
  permitted(
    actor: string,
    projectId: string,
    id: string,
    usage: "consult" | "bridge",
    automatic = false,
    revision?: number,
  ) {
    this.projects.access(actor, projectId, "write");
    const v = this.get(actor, id, projectId);
    if (
      v.state !== "accepted" ||
      !v.target ||
      !v.policy[usage] ||
      (automatic && !v.policy.automatic) ||
      (revision != null && v.revision !== revision)
    )
      throw changed();
    this.identity(v.source.ownerId, v.source.id);
    this.identity(v.target.ownerId, v.target.id);
    const outgoing = v.source.id === projectId;
    if (!outgoing && v.policy.direction !== "both")
      throw new HubError(
        403,
        "TEAM_LINK_DIRECTION",
        "Связь разрешена только в другом направлении.",
      );
    return {
      link: v,
      source: outgoing ? v.source : v.target,
      target: outgoing ? v.target : v.source,
    };
  }
}
