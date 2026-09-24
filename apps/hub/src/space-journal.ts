import { randomUUID } from "node:crypto";
import type { SpaceJournalEvent } from "@codex-web/shared";
import type { CollaborationSpaces, Space } from "./collaboration-spaces.js";

/** Atomic historical metadata; Results remain projections of their canonical grants. */
export class SpaceJournal {
  results?: (actor: string, spaceId: string) => SpaceJournalEvent[];
  constructor(readonly spaces: CollaborationSpaces) {
    spaces.team.db.exec(`
      CREATE TABLE IF NOT EXISTS space_journal(
        id TEXT PRIMARY KEY, spaceId TEXT NOT NULL REFERENCES collaboration_spaces(id) ON DELETE CASCADE,
        recipient TEXT, seen INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS space_journal_space ON space_journal(spaceId);
    `);
  }
  record(actor: string, space: Space, previous: Space | null) {
    const user = this.spaces.team.registry.user(actor);
    const append = (
      kind: SpaceJournalEvent["kind"],
      title: string,
      projectId?: string,
      subjectId?: string,
    ) => {
      const event: SpaceJournalEvent = {
        id: randomUUID(),
        at: Date.now(),
        author: { id: actor, name: user.name },
        kind,
        title,
        ...(projectId ? { projectId } : {}),
        ...(subjectId ? { subjectId } : {}),
      };
      if (kind === "access-changed" && subjectId && projectId)
        this.spaces.team.db
          .prepare(
            "UPDATE space_journal SET seen=1 WHERE spaceId=? AND recipient=? AND json_extract(data,'$.projectId')=?",
          )
          .run(space.id, subjectId, projectId);
      this.spaces.team.db
        .prepare("INSERT INTO space_journal VALUES(?,?,?,0,?)")
        .run(
          event.id,
          space.id,
          kind === "access-changed" && subjectId !== actor ? (subjectId ?? null) : null,
          JSON.stringify(event),
        );
    };
    if (!previous) append("created", "Создано пространство");
    if (previous && previous.title !== space.title)
      append("renamed", `Пространство переименовано: ${space.title}`);
    for (const id of space.members.filter((id) => !previous?.members.includes(id)))
      if (previous)
        append("joined", `${this.spaces.team.registry.user(id).name} присоединился`, undefined, id);
    for (const id of previous?.members.filter((id) => !space.members.includes(id)) ?? [])
      append(
        actor === id ? "left" : "removed",
        actor === id
          ? `${this.spaces.team.registry.user(id).name} покинул пространство`
          : `${this.spaces.team.registry.user(id).name}: участие прекращено`,
        undefined,
        id,
      );
    for (const p of space.projects) {
      const old = previous?.projects.find((v) => v.id === p.id);
      if (!old) append("project-added", "Добавлен проект", p.id);
      if (old)
        for (const id of space.members) {
          if (p.grants[id] && p.grants[id] !== old.grants[id])
            append(
              "access-changed",
              `${this.spaces.team.registry.user(id).name}: ${p.grants[id] === "direct" ? "полный доступ" : "совместная работа"}`,
              p.id,
              id,
            );
          if (p.requests?.includes(id) && !old.requests?.includes(id))
            append(
              "access-requested",
              `${this.spaces.team.registry.user(id).name} запросил полный доступ`,
              p.id,
              id,
            );
        }
    }
    // Removed projects retain only a generic historical fact, never a stale repository title.
    for (const p of previous?.projects ?? [])
      if (!space.projects.some((v) => v.id === p.id))
        append("project-removed", "Проект убран из пространства");
    this.spaces.team.db
      .prepare(
        "DELETE FROM space_journal WHERE spaceId=? AND rowid NOT IN (SELECT rowid FROM space_journal WHERE spaceId=? ORDER BY rowid DESC LIMIT 500)",
      )
      .run(space.id, space.id);
  }
  private visible(actor: string, space: Space, event: SpaceJournalEvent) {
    if (!event.projectId) return event;
    const p = space.projects.find(
      (p) => p.id === event.projectId && (p.ownerId === actor || p.grants[actor]),
    );
    return p ? { ...event, projectName: p.name } : null;
  }
  list(actor: string, id: string): SpaceJournalEvent[] {
    const space = this.spaces.access(actor, id);
    const events = this.spaces.team.db
      .prepare("SELECT data FROM space_journal WHERE spaceId=? ORDER BY rowid DESC LIMIT 500")
      .all(id)
      .flatMap((row) => {
        const event = this.visible(actor, space, JSON.parse(String(row.data)));
        return event ? [event] : [];
      });
    return [...events, ...(this.results?.(actor, id) ?? [])]
      .sort((a, b) => b.at - a.at || a.id.localeCompare(b.id))
      .slice(0, 200);
  }
  attention(actor: string, space: Space) {
    return this.spaces.team.db
      .prepare(
        "SELECT data FROM space_journal WHERE spaceId=? AND recipient=? AND seen=0 ORDER BY rowid DESC LIMIT 50",
      )
      .all(space.id, actor)
      .flatMap((row) => {
        const event = this.visible(actor, space, JSON.parse(String(row.data)));
        return event ? [event] : [];
      });
  }
  read(actor: string, spaceId: string, id: string) {
    this.spaces.access(actor, spaceId);
    this.spaces.team.db
      .prepare("UPDATE space_journal SET seen=1 WHERE id=? AND spaceId=? AND recipient=?")
      .run(id, spaceId, actor);
    return { read: true };
  }
}
