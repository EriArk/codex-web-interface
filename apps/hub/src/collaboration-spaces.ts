import { randomUUID } from "node:crypto";
import {
  type CollaborationAccess,
  type CollaborationCatalog,
  type CollaborationKind,
  type CollaborationSpace,
  HubError,
} from "@codex-web/shared";
import type { TeamProjects } from "./team-projects.js";

export type VerifiedSpaceProject = { personalProjectId: string; name: string; repository: string };
type Project = VerifiedSpaceProject & {
  id: string;
  ownerId: string;
  grants: Record<string, CollaborationAccess>;
  copies: Record<string, string>;
};
type Invitation = {
  userId: string;
  access: CollaborationAccess;
  requestedAccess: CollaborationAccess;
};
type Space = {
  id: string;
  title: string;
  kind: CollaborationKind;
  curatorId: string;
  revision: number;
  members: string[];
  projects: Project[];
  invitations: Invitation[];
};
const missing = () => new HubError(404, "SPACE_NOT_FOUND", "Пространство недоступно.");
const conflict = () =>
  new HubError(409, "SPACE_CHANGED", "Пространство изменилось. Открой его снова.");

/** Small, atomic metadata aggregate. Personal runtime state is never moved or copied. */
export class CollaborationSpaces {
  constructor(readonly team: TeamProjects) {
    team.db.exec(`
      CREATE TABLE IF NOT EXISTS collaboration_spaces(id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS collaboration_space_people(
        spaceId TEXT NOT NULL REFERENCES collaboration_spaces(id) ON DELETE CASCADE,
        userId TEXT NOT NULL REFERENCES team_users(id),PRIMARY KEY(spaceId,userId));
      CREATE INDEX IF NOT EXISTS collaboration_people_user ON collaboration_space_people(userId);
    `);
  }
  private read(id: string): Space {
    const row = this.team.db.prepare("SELECT data FROM collaboration_spaces WHERE id=?").get(id);
    if (!row) throw missing();
    return JSON.parse(String(row.data));
  }
  private save(space: Space) {
    this.team.db
      .prepare(
        "INSERT INTO collaboration_spaces VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(space.id, JSON.stringify(space));
    this.team.db.prepare("DELETE FROM collaboration_space_people WHERE spaceId=?").run(space.id);
    for (const id of new Set([...space.members, ...space.invitations.map((i) => i.userId)]))
      this.team.db.prepare("INSERT INTO collaboration_space_people VALUES(?,?)").run(space.id, id);
  }
  private all(actor: string): Space[] {
    this.team.registry.active(actor);
    return this.team.db
      .prepare(`SELECT s.data FROM collaboration_spaces s JOIN collaboration_space_people p
      ON p.spaceId=s.id WHERE p.userId=? ORDER BY s.rowid DESC`)
      .all(actor)
      .map((r) => JSON.parse(String(r.data)) as Space);
  }
  private person(id: string) {
    const u = this.team.registry.user(id);
    return { id: u.id, name: u.name };
  }
  access(actor: string, id: string, revision?: number) {
    this.team.registry.active(actor);
    const space = this.read(id);
    if (!space.members.includes(actor)) throw missing();
    if (revision !== undefined && space.revision !== revision) throw conflict();
    return space;
  }
  invitation(actor: string, id: string, revision: number) {
    this.team.registry.active(actor);
    const space = this.read(id);
    const invitation = space.invitations.find((i) => i.userId === actor);
    if (!invitation) throw missing();
    if (space.revision !== revision) throw conflict();
    this.team.registry.active(space.curatorId);
    return { space, invitation };
  }
  private view(actor: string, s: Space): CollaborationSpace {
    return {
      id: s.id,
      title: s.title,
      kind: s.kind,
      curatorId: s.curatorId,
      revision: s.revision,
      members: s.members.map((id) => this.person(id)),
      pending: s.invitations.map((i) => this.person(i.userId)),
      projects: s.projects.map((p) => ({
        id: p.id,
        ownerId: p.ownerId,
        name: p.name,
        repository: p.repository,
        ...(p.copies[actor] ? { personalProjectId: p.copies[actor] } : {}),
        access: p.ownerId === actor ? "owner" : p.grants[actor]!,
      })),
    };
  }
  catalog(actor: string): CollaborationCatalog {
    const spaces = this.all(actor);
    return {
      spaces: spaces.filter((s) => s.members.includes(actor)).map((s) => this.view(actor, s)),
      invitations: spaces.flatMap((s) => {
        const i = s.invitations.find((v) => v.userId === actor),
          p = s.projects[0];
        return i && p
          ? [
              {
                spaceId: s.id,
                title: s.title,
                kind: s.kind,
                revision: s.revision,
                from: this.person(s.curatorId),
                project: { name: p.name, repository: p.repository },
                access: i.access,
                requestedAccess: i.requestedAccess,
              },
            ]
          : [];
      }),
    };
  }
  private available(actor: string, projectId: string) {
    if (
      this.all(actor).some(
        (s) => s.members.includes(actor) && s.projects.some((p) => p.copies[actor] === projectId),
      )
    )
      throw new HubError(
        409,
        "PROJECT_ALREADY_IN_SPACE",
        "Этот проект уже находится в общем пространстве.",
      );
  }
  private project(actor: string, verified: VerifiedSpaceProject): Project {
    this.available(actor, verified.personalProjectId);
    return {
      ...verified,
      id: randomUUID(),
      ownerId: actor,
      grants: {},
      copies: { [actor]: verified.personalProjectId },
    };
  }
  create(
    actor: string,
    key: string,
    input: {
      title: string;
      kind: CollaborationKind;
      userId: string;
      access: CollaborationAccess;
      requestedAccess: CollaborationAccess;
      personalProjectId: string;
    },
    verified: VerifiedSpaceProject,
  ) {
    return this.team.once(actor, "spaces.create", key, input, () => {
      this.team.registry.active(input.userId);
      if (actor === input.userId)
        throw new HubError(400, "SPACE_SELF_INVITE", "Выбери другого участника.");
      if (this.all(actor).length >= 100)
        throw new HubError(409, "SPACE_LIMIT", "Достигнут предел пространств.");
      const space: Space = {
        id: randomUUID(),
        title: input.title,
        kind: input.kind,
        curatorId: actor,
        revision: 1,
        members: [actor],
        projects: [this.project(actor, verified)],
        invitations: [
          { userId: input.userId, access: input.access, requestedAccess: input.requestedAccess },
        ],
      };
      this.save(space);
      return { id: space.id };
    });
  }
  answer(
    actor: string,
    id: string,
    key: string,
    input: {
      revision: number;
      accept: boolean;
      personalProjectId?: string;
      access?: CollaborationAccess;
    },
    verified?: VerifiedSpaceProject,
  ) {
    return this.team.once(actor, "spaces.answer:" + id, key, input, () => {
      const { space, invitation } = this.invitation(actor, id, input.revision);
      if (input.accept) {
        if (!verified) throw new HubError(400, "SPACE_PROJECT_REQUIRED", "Выбери свой проект.");
        this.available(actor, verified.personalProjectId);
        if (space.kind === "project") {
          const p = space.projects[0]!;
          if (p.repository !== verified.repository)
            throw new HubError(
              409,
              "SPACE_REPOSITORY_MISMATCH",
              "Выбери свою локальную копию того же репозитория.",
            );
          p.copies[actor] = verified.personalProjectId;
        } else {
          if (!input.access)
            throw new HubError(400, "SPACE_ACCESS_REQUIRED", "Выбери доступ к своему проекту.");
          const p = this.project(actor, verified);
          for (const member of space.members) p.grants[member] = input.access;
          space.projects.push(p);
        }
        for (const p of space.projects)
          if (p.ownerId !== actor) p.grants[actor] = invitation.access;
        space.members.push(actor);
      }
      space.invitations = space.invitations.filter((i) => i.userId !== actor);
      space.revision++;
      this.save(space);
      return { ok: true };
    });
  }
  rename(actor: string, id: string, key: string, input: { revision: number; title: string }) {
    return this.team.once(actor, "spaces.rename:" + id, key, input, () => {
      const space = this.access(actor, id, input.revision);
      if (space.curatorId !== actor)
        throw new HubError(
          403,
          "SPACE_CURATOR_REQUIRED",
          "Название меняет создатель пространства.",
        );
      space.title = input.title;
      space.revision++;
      this.save(space);
      return { ok: true };
    });
  }
  leave(actor: string, id: string, key: string, input: { revision: number }) {
    return this.team.once(actor, "spaces.leave:" + id, key, input, () => {
      const space = this.access(actor, id, input.revision);
      if (space.curatorId === actor) {
        this.team.db.prepare("DELETE FROM collaboration_spaces WHERE id=?").run(id);
      } else {
        space.members = space.members.filter((u) => u !== actor);
        space.projects = space.projects.filter((p) => p.ownerId !== actor);
        for (const p of space.projects) {
          delete p.grants[actor];
          delete p.copies[actor];
        }
        space.revision++;
        this.save(space);
      }
      return { ok: true };
    });
  }
}
