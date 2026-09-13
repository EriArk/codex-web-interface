import { createHash } from "node:crypto";
import {
  HubError,
  type TeamBridge,
  type TeamBridgeEntry,
  type TeamBridgeFields,
  type TeamBridgeParticipant,
  teamBridgeEntrySchema,
  teamBridgeFields,
} from "@codex-web/shared";
import { z } from "zod";
import type { TeamLinks } from "./team-links.js";

export const bridgeChanged = () =>
  new HubError(
    409,
    "BRIDGE_CHANGED",
    "Обсуждение или доступ изменились. Обнови сохранённую версию.",
  );
const missing = () => new HubError(404, "BRIDGE_MISSING", "Обсуждение недоступно.");
export const bridgeId = (id: string, label: string) => {
  const h = createHash("sha256")
    .update(JSON.stringify([id, label]))
    .digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

/** Deliberately shared coordination records; private native bindings live in the runner. */
export class TeamBridges {
  stopRun: (id: string) => void = () => {};
  constructor(readonly links: TeamLinks) {}
  get projects() {
    return this.links.projects;
  }
  get db() {
    return this.links.db;
  }
  raw(id: string): TeamBridge {
    const row = this.db.prepare("SELECT value FROM team_bridges WHERE id=?").get(id);
    if (!row) throw missing();
    return JSON.parse(String(row.value));
  }
  save(v: TeamBridge) {
    v.revision++;
    v.updatedAt = Date.now();
    this.db
      .prepare("UPDATE team_bridges SET state=?,value=?,updatedAt=? WHERE id=?")
      .run(v.state, JSON.stringify(v), v.updatedAt, v.id);
  }
  linked(v: TeamBridge, p: TeamBridgeParticipant) {
    if (p.state !== "accepted") throw missing();
    const owner = this.projects.access(v.ownerId, v.projectId, "owner");
    if (owner.archived) throw missing();
    const allowed = this.links.permitted(
      v.ownerId,
      v.projectId,
      p.linkId,
      "bridge",
      false,
      p.linkRevision,
    );
    if (allowed.target.id !== p.projectId || allowed.target.ownerId !== p.userId) throw missing();
    return allowed;
  }
  access(actor: string, id: string, write = false) {
    this.projects.registry.active(actor);
    const v = this.raw(id);
    const own = this.db
      .prepare(
        "SELECT 1 FROM team_project_members WHERE projectId=? AND userId=? AND state='active'",
      )
      .get(v.projectId, actor);
    if (own) {
      const p = this.projects.access(actor, v.projectId, write ? "write" : "read");
      return {
        bridge: v,
        myProjectId: v.projectId,
        canWrite: p.role !== "viewer" && !p.archived,
        canCoordinate: p.role === "owner" && p.ownerId === v.ownerId && !p.archived,
        canAdopt: p.role === "owner" && p.ownerId !== v.ownerId && !p.archived,
      };
    }
    const p = v.participants.find((p) => p.userId === actor && p.state === "accepted");
    if (!p) throw missing();
    this.linked(v, p);
    this.projects.access(actor, p.projectId, "owner");
    return {
      bridge: v,
      myProjectId: p.projectId,
      canWrite: true,
      canCoordinate: false,
      canAdopt: false,
    };
  }
  get(actor: string, id: string, before?: number, filter = "all") {
    const access = this.access(actor, id);
    const kinds = filter === "decision" ? ["decision", "coordinator"] : [filter, filter];
    const rows = this.db
      .prepare(
        "SELECT seq,value FROM team_bridge_entries WHERE bridgeId=? AND seq<? AND (?='all' OR json_extract(value,'$.kind') IN (?,?)) ORDER BY seq DESC LIMIT 31",
      )
      .all(id, before ?? Number.MAX_SAFE_INTEGER, filter, ...kinds);
    return {
      ...access,
      entries: rows
        .slice(0, 30)
        .reverse()
        .map((r) => {
          const { privateSourceId, ...entry } = JSON.parse(String(r.value));
          return {
            ...entry,
            seq: Number(r.seq),
            ...(privateSourceId ? { source: entry.userId === actor ? "own" : "private" } : {}),
          };
        }) as TeamBridgeEntry[],
      nextBefore: rows.length > 30 ? Number(rows[29]!.seq) : null,
    };
  }
  page(actor: string, projectId: string, offset = 0) {
    this.projects.access(actor, projectId);
    const rows = this.db
      .prepare(`SELECT value FROM team_bridges WHERE projectId=? OR EXISTS(
      SELECT 1 FROM json_each(team_bridges.value,'$.participants') p WHERE json_extract(p.value,'$.projectId')=? AND json_extract(p.value,'$.userId')=? AND json_extract(p.value,'$.state')='accepted') ORDER BY updatedAt DESC,id LIMIT 21 OFFSET ?`)
      .all(projectId, projectId, actor, offset);
    const items: TeamBridge[] = [];
    for (const row of rows.slice(0, 20)) {
      try {
        items.push(this.access(actor, JSON.parse(String(row.value)).id).bridge);
      } catch {}
    }
    return { items, nextOffset: rows.length > 20 ? offset + 20 : null };
  }
  invitations(actor: string) {
    this.projects.registry.active(actor);
    const rows = this.db
      .prepare(
        `SELECT value FROM team_bridges WHERE EXISTS(SELECT 1 FROM json_each(team_bridges.value,'$.participants') p WHERE json_extract(p.value,'$.userId')=? AND json_extract(p.value,'$.state')='invited') ORDER BY updatedAt DESC,id LIMIT 100`,
      )
      .all(actor);
    return rows.flatMap((row) => {
      const v = JSON.parse(String(row.value)) as TeamBridge,
        p = v.participants.find((p) => p.userId === actor && p.state === "invited")!;
      try {
        this.linked(v, { ...p, state: "accepted" });
      } catch {
        return [];
      }
      return [
        {
          id: v.id,
          revision: v.revision,
          title: v.title,
          goal: v.goal,
          criteria: v.criteria,
          ownerName: v.ownerName,
          projectTitle: v.projectTitle,
          targetTitle: p.projectTitle,
        },
      ];
    });
  }
  create(actor: string, projectId: string, id: string, raw: unknown) {
    const p = this.projects.access(actor, projectId, "write"),
      input = teamBridgeFields.parse(raw);
    this.projects.once(actor, "bridge.create", id, { projectId, input }, () => {
      if (this.db.prepare("SELECT 1 FROM team_bridges WHERE id=?").get(id)) throw bridgeChanged();
      if (
        Number(
          this.db.prepare("SELECT COUNT(*) n FROM team_bridges WHERE projectId=?").get(projectId)
            ?.n,
        ) >= 100
      )
        throw new HubError(409, "BRIDGE_CAPACITY", "В проекте уже 100 обсуждений.");
      const v: TeamBridge = {
        ...input,
        id,
        projectId,
        projectTitle: p.title,
        ownerId: p.ownerId,
        ownerName: this.projects.registry.user(p.ownerId).name,
        state: "active",
        revision: 1,
        participants: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      this.db
        .prepare("INSERT INTO team_bridges VALUES(?,?,?,?,?)")
        .run(id, projectId, v.state, JSON.stringify(v), v.updatedAt);
      this.projects.changed(actor, projectId, "bridge.created", id);
      return { id };
    });
    return this.get(actor, id);
  }
  idle(id: string) {
    if (
      this.db
        .prepare(
          `SELECT 1 FROM team_bridge_runs WHERE bridgeId=? AND (state IN ('prepared','waiting','running','consulting','unknown') OR json_extract(value,'$.step.state') IN ('dispatching','running','unknown'))`,
        )
        .get(id)
    )
      throw new HubError(409, "BRIDGE_BUSY", "Сначала заверши или проверь текущую координацию.");
  }
  edit(actor: string, id: string, key: string, input: TeamBridgeFields & { revision: number }) {
    const access = this.access(actor, id, true);
    if (!access.canCoordinate) throw bridgeChanged();
    this.projects.once(actor, "bridge.edit:" + id, key, input, () => {
      this.idle(id);
      const v = this.raw(id);
      if (v.revision !== input.revision) throw bridgeChanged();
      Object.assign(
        v,
        teamBridgeFields.parse({
          title: input.title,
          goal: input.goal,
          criteria: input.criteria,
          budget: input.budget,
        }),
      );
      this.save(v);
      return { id };
    });
    return this.get(actor, id);
  }
  invite(actor: string, id: string, key: string, input: { revision: number; linkId: string }) {
    const { bridge: v } = this.access(actor, id, true);
    this.projects.access(actor, v.projectId, "owner");
    const allowed = this.links.permitted(actor, v.projectId, input.linkId, "bridge");
    this.projects.once(actor, "bridge.invite:" + id, key, input, () => {
      this.idle(id);
      const latest = this.raw(id);
      if (latest.revision !== input.revision || latest.ownerId !== actor) throw bridgeChanged();
      if (latest.participants.filter((p) => !["declined", "removed"].includes(p.state)).length >= 8)
        throw new HubError(
          409,
          "BRIDGE_PARTICIPANTS",
          "В одном обсуждении доступно до 8 связанных проектов.",
        );
      if (
        latest.participants.some(
          (p) => p.userId === allowed.target.ownerId && ["invited", "accepted"].includes(p.state),
        )
      )
        throw bridgeChanged();
      latest.participants = latest.participants.filter((p) => p.linkId !== input.linkId);
      latest.participants.push({
        linkId: input.linkId,
        projectId: allowed.target.id,
        projectTitle: allowed.target.title,
        userId: allowed.target.ownerId,
        userName: allowed.target.ownerName,
        linkRevision: allowed.link.revision,
        state: "invited",
      });
      this.save(latest);
      this.projects.changed(actor, v.projectId, "bridge.invited", id);
      return { id };
    });
    return this.get(actor, id);
  }
  answer(actor: string, id: string, key: string, input: { revision: number; accept: boolean }) {
    this.projects.registry.active(actor);
    this.projects.once(actor, "bridge.answer:" + id, key, input, () => {
      this.idle(id);
      const v = this.raw(id),
        p = v.participants.find((p) => p.userId === actor && p.state === "invited");
      if (!p) throw missing();
      this.linked(v, { ...p, state: "accepted" });
      if (v.revision !== input.revision) throw bridgeChanged();
      p.state = input.accept ? "accepted" : "declined";
      this.save(v);
      this.projects.changed(actor, p.projectId, "bridge." + p.state, id);
      return { id };
    });
    return { ok: true };
  }
  append(
    v: TeamBridge,
    actor: string,
    id: string,
    entry: Omit<TeamBridgeEntry, "id" | "seq" | "userId" | "userName" | "createdAt"> & {
      privateSourceId?: string;
    },
  ) {
    const value = {
      ...entry,
      id,
      userId: actor,
      userName: this.projects.registry.user(actor).name,
      createdAt: Date.now(),
    };
    this.db
      .prepare("INSERT OR IGNORE INTO team_bridge_entries(id,bridgeId,value) VALUES(?,?,?)")
      .run(id, v.id, JSON.stringify(value));
    // Bounded checkpoints retain the latest 500 records; action receipts remain durable.
    this.db
      .prepare(
        "DELETE FROM team_bridge_entries WHERE bridgeId=? AND seq NOT IN (SELECT seq FROM team_bridge_entries WHERE bridgeId=? ORDER BY seq DESC LIMIT 500)",
      )
      .run(v.id, v.id);
    return value;
  }
  post(actor: string, id: string, key: string, raw: unknown) {
    this.access(actor, id, true);
    const { sourceId, ...fields } = z
      .object({ sourceId: z.string().uuid().optional() })
      .passthrough()
      .parse(raw);
    const input = {
      ...teamBridgeEntrySchema.parse(fields),
      ...(sourceId ? { privateSourceId: sourceId } : {}),
    };
    if (
      sourceId &&
      !this.db
        .prepare("SELECT 1 FROM team_bridge_sources WHERE id=? AND bridgeId=? AND ownerId=?")
        .get(sourceId, id, actor)
    )
      throw missing();
    this.projects.once(actor, "bridge.post:" + id, key, input, () => {
      const { bridge: v } = this.access(actor, id, true);
      if (
        input.targetProjectId &&
        input.targetProjectId !== v.projectId &&
        !v.participants.some((p) => p.projectId === input.targetProjectId && p.state === "accepted")
      )
        throw bridgeChanged();
      this.append(v, actor, key, input);
      this.save(v);
      this.projects.changed(actor, v.projectId, "bridge.finding", id);
      return { id };
    });
    return this.get(actor, id);
  }
  action(
    actor: string,
    id: string,
    key: string,
    input: { revision: number; action: "stop" | "resolve" | "reopen" | "adopt" },
  ) {
    this.access(actor, id, true);
    this.projects.once(actor, "bridge.action:" + id, key, input, () => {
      const v = this.raw(id);
      if (v.revision !== input.revision) throw bridgeChanged();
      if (input.action === "stop") this.stopRun(id);
      else this.idle(id);
      if (input.action === "adopt") {
        const p = this.projects.access(actor, v.projectId, "owner");
        v.ownerId = actor;
        v.ownerName = this.projects.registry.user(actor).name;
        v.projectTitle = p.title;
        v.participants = v.participants.map((p) => ({ ...p, state: "removed" }));
      }
      v.state =
        input.action === "stop" ? "stopped" : input.action === "resolve" ? "resolved" : "active";
      this.append(v, actor, key, {
        kind: "status",
        text:
          input.action === "stop"
            ? "Обсуждение остановлено; уже отправленный личный ход не прерывается."
            : input.action === "resolve"
              ? "Участник отметил цель достигнутой."
              : input.action === "adopt"
                ? "Новый владелец принял координацию; старые приглашения закрыты."
                : "Обсуждение открыто заново. Запуск координатора подтверждается отдельно.",
      });
      this.save(v);
      this.projects.changed(actor, v.projectId, "bridge." + input.action, id);
      return { id };
    });
    return this.get(actor, id);
  }
  workPlan(actor: string, id: string, entryId: string, key: string) {
    const access = this.access(actor, id, true),
      row = this.db
        .prepare("SELECT value FROM team_bridge_entries WHERE bridgeId=? AND id=?")
        .get(id, entryId);
    if (!row) throw missing();
    const entry = JSON.parse(String(row.value)) as TeamBridgeEntry;
    if (entry.kind !== "work" || !entry.targetProjectId) throw bridgeChanged();
    if (entry.targetProjectId !== access.bridge.projectId) {
      const participant = access.bridge.participants.find(
        (p) => p.projectId === entry.targetProjectId && p.userId === actor,
      );
      if (!participant) throw missing();
      this.linked(access.bridge, participant);
    }
    this.projects.access(actor, entry.targetProjectId, "write");
    if (entry.planId) {
      this.projects.get(actor, entry.targetProjectId, entry.planId);
      return { id: entry.planId, projectId: entry.targetProjectId };
    }
    const planId = bridgeId(entryId, "plan");
    // Deterministic ID also survives acknowledgement loss before the Bridge records the backlink.
    const result = this.projects.put(actor, entry.targetProjectId, planId, key, {
      revision: 0,
      assigneeId: actor,
      content: {
        kind: "plan",
        title: access.bridge.title,
        description: entry.text,
        status: "draft",
        sections: [
          {
            id: bridgeId(entryId, "section"),
            title: "Согласованная работа",
            items: [
              {
                id: bridgeId(entryId, "item"),
                text: "Проверить предложение и выполнить согласованные изменения",
                checked: false,
              },
            ],
          },
        ],
      },
    });
    entry.planId = result.id;
    this.db
      .prepare("UPDATE team_bridge_entries SET value=? WHERE id=?")
      .run(JSON.stringify(entry), entryId);
    return { id: result.id, projectId: entry.targetProjectId };
  }
}
