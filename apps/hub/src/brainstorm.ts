import { randomUUID } from "node:crypto";
import {
  type BrainstormCard,
  type BrainstormConversion,
  type BrainstormRoom,
  type BrainstormState,
  HubError,
} from "@codex-web/shared";
import { z } from "zod";
import { CollaborationChat } from "./collaboration-chat.js";
import type { TeamProjects } from "./team-projects.js";

const missing = () => new HubError(404, "ROOM_MISSING", "Комната недоступна.");
const changed = () =>
  new HubError(409, "ROOM_CHANGED", "Материал уже изменился. Обнови его; твой текст сохранён.");
export const roomCardSchema = z
  .object({
    kind: z.enum(["note", "link", "file", "drawing"]),
    title: z.string().trim().max(180),
    text: z.string().max(16000),
    url: z
      .string()
      .max(4000)
      .refine((v) => !v || /^https?:\/\//i.test(v)),
    fileId: z.string().uuid().nullable(),
    x: z.number().int().min(0).max(5000),
    y: z.number().int().min(0).max(5000),
    width: z.number().int().min(220).max(800),
    points: z
      .array(
        z
          .array(z.number().min(-1).max(1000))
          .length(2)
          .refine((p) => (p[0] === -1 && p[1] === -1) || (p[0]! >= 0 && p[1]! >= 0)),
      )
      .max(2000),
    revision: z.number().int().nonnegative(),
  })
  .strict()
  .refine((v) => (v.kind !== "file" || !!v.fileId) && (v.kind !== "link" || !!v.url));
type CardInput = z.infer<typeof roomCardSchema>;
type RoomRow = {
  id: string;
  title: string;
  description: string;
  ownerId: string;
  revision: number;
  closed: number;
  createdAt: number;
  updatedAt: number;
};

/** Public to active installation users; following is notification preference, never an ACL. */
export class BrainstormRooms {
  readonly chat: CollaborationChat;
  readonly presence = new Map<string, Map<string, number>>();
  constructor(readonly team: TeamProjects) {
    team.db.exec(`
      CREATE TABLE IF NOT EXISTS brainstorm_rooms(id TEXT PRIMARY KEY,title TEXT NOT NULL,description TEXT NOT NULL,ownerId TEXT NOT NULL REFERENCES team_users(id),revision INTEGER NOT NULL,closed INTEGER NOT NULL,createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS brainstorm_people(roomId TEXT NOT NULL REFERENCES brainstorm_rooms(id),userId TEXT NOT NULL REFERENCES team_users(id),following INTEGER NOT NULL,muted INTEGER NOT NULL,PRIMARY KEY(roomId,userId));
      CREATE TABLE IF NOT EXISTS brainstorm_cards(id TEXT PRIMARY KEY,roomId TEXT NOT NULL REFERENCES brainstorm_rooms(id),revision INTEGER NOT NULL,deleted INTEGER NOT NULL,value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS brainstorm_cards_room ON brainstorm_cards(roomId);
      CREATE TABLE IF NOT EXISTS brainstorm_changes(seq INTEGER PRIMARY KEY AUTOINCREMENT,roomId TEXT NOT NULL,cardId TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS brainstorm_changes_room ON brainstorm_changes(roomId,seq);
      CREATE TABLE IF NOT EXISTS brainstorm_conversions(id TEXT PRIMARY KEY,roomId TEXT NOT NULL REFERENCES brainstorm_rooms(id),ownerId TEXT NOT NULL,value TEXT NOT NULL);
    `);
    this.chat = new CollaborationChat(
      {
        team,
        access: (actor, id) => {
          this.access(actor, id);
        },
      },
      "brainstorm",
    );
  }
  access(actor: string, id: string, write = false, owner = false): RoomRow {
    this.team.registry.active(actor);
    const room = this.team.db.prepare("SELECT * FROM brainstorm_rooms WHERE id=?").get(id) as
      | RoomRow
      | undefined;
    if (!room) throw missing();
    if (owner && room.ownerId !== actor)
      throw new HubError(403, "ROOM_OWNER", "Это действие доступно создателю комнаты.");
    if (write && room.closed)
      throw new HubError(409, "ROOM_CLOSED", "Комната закрыта для изменений.");
    return room;
  }
  view(actor: string, id: string): BrainstormRoom {
    const row = this.access(actor, id),
      owner = this.team.registry.user(row.ownerId);
    const preference = this.team.db
      .prepare("SELECT following,muted FROM brainstorm_people WHERE roomId=? AND userId=?")
      .get(id, actor);
    return {
      id,
      title: row.title,
      description: row.description,
      owner: { id: owner.id, name: owner.name },
      revision: row.revision,
      closed: !!row.closed,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      following: !!preference?.following,
      muted: !!preference?.muted,
      unread: preference?.following && !preference.muted ? this.chat.unread(actor, id) : 0,
      projects: this.team.db
        .prepare("SELECT value FROM brainstorm_conversions WHERE roomId=?")
        .all(id)
        .flatMap((r) => {
          const value = JSON.parse(String(r.value));
          return value.projectId
            ? [
                {
                  id: row.ownerId === actor ? value.projectId : value.id,
                  name: value.title,
                  repository: value.repository ?? null,
                  spaceId: value.spaceId ?? null,
                },
              ]
            : [];
        }),
    };
  }
  catalog(actor: string, offset = 0) {
    this.team.registry.active(actor);
    const rows = this.team.db
      .prepare(
        "SELECT id FROM brainstorm_rooms ORDER BY closed,updatedAt DESC,id LIMIT 31 OFFSET ?",
      )
      .all(offset);
    return {
      rooms: rows.slice(0, 30).map((r) => this.view(actor, String(r.id))),
      nextOffset: rows.length > 30 ? offset + 30 : null,
    };
  }
  create(actor: string, key: string, input: { title: string; description: string }) {
    return this.team.once(actor, "brainstorm.create", key, input, () => {
      if (
        Number(
          this.team.db.prepare("SELECT count(*) n FROM brainstorm_rooms WHERE ownerId=?").get(actor)
            ?.n,
        ) >= 100
      )
        throw new HubError(409, "ROOM_LIMIT", "Достигнут предел комнат: 100.");
      const id = randomUUID(),
        now = Date.now();
      this.team.db
        .prepare("INSERT INTO brainstorm_rooms VALUES(?,?,?,?,1,0,?,?)")
        .run(id, input.title, input.description, actor, now, now);
      this.team.db.prepare("INSERT INTO brainstorm_people VALUES(?,?,1,0)").run(id, actor);
      return this.view(actor, id);
    });
  }
  edit(
    actor: string,
    id: string,
    key: string,
    input: { title: string; description: string; revision: number; closed: boolean },
  ) {
    this.access(actor, id, false, true);
    return this.team.once(actor, "brainstorm.edit:" + id, key, input, () => {
      if (this.access(actor, id).revision !== input.revision) throw changed();
      this.team.db
        .prepare(
          "UPDATE brainstorm_rooms SET title=?,description=?,closed=?,revision=revision+1,updatedAt=? WHERE id=?",
        )
        .run(input.title, input.description, +input.closed, Date.now(), id);
      return this.view(actor, id);
    });
  }
  follow(actor: string, id: string, input: { following: boolean; muted: boolean }) {
    this.access(actor, id);
    this.team.db
      .prepare(
        "INSERT INTO brainstorm_people VALUES(?,?,?,?) ON CONFLICT(roomId,userId) DO UPDATE SET following=excluded.following,muted=excluded.muted",
      )
      .run(id, actor, +input.following, +input.muted);
    return this.view(actor, id);
  }
  state(actor: string, id: string, since?: number): BrainstormState {
    const room = this.view(actor, id),
      db = this.team.db;
    const bounds = db
      .prepare("SELECT min(seq) first,max(seq) last FROM brainstorm_changes WHERE roomId=?")
      .get(id)!;
    const version = Number(bounds.last ?? 0);
    const reset =
      since === undefined ||
      since > version ||
      (Number(bounds.first ?? 0) > since + 1 && since !== version);
    const rows = reset
      ? db.prepare("SELECT * FROM brainstorm_cards WHERE roomId=? AND deleted=0").all(id)
      : db
          .prepare(
            "SELECT DISTINCT c.* FROM brainstorm_changes e JOIN brainstorm_cards c ON c.id=e.cardId WHERE e.roomId=? AND e.seq>?",
          )
          .all(id, since!);
    const people = this.presence.get(id) ?? new Map<string, number>();
    people.set(actor, Date.now());
    for (const [user, at] of people)
      if (Date.now() - at > 45000 || this.team.registry.user(user).state !== "active")
        people.delete(user);
    this.presence.delete(id);
    this.presence.set(id, people);
    while (this.presence.size > 100) this.presence.delete(this.presence.keys().next().value!);
    return {
      room,
      version,
      reset,
      cards: rows.filter((r) => !r.deleted).map((r) => JSON.parse(String(r.value))),
      removed: rows.filter((r) => r.deleted).map((r) => String(r.id)),
      people: [...people.keys()].map((id) => ({ id, name: this.team.registry.user(id).name })),
    };
  }
  put(actor: string, roomId: string, id: string, key: string, raw: unknown) {
    this.access(actor, roomId, true);
    const input = roomCardSchema.parse(raw);
    return this.team.once(actor, "brainstorm.card:" + roomId + ":" + id, key, input, () => {
      const db = this.team.db,
        previous = db.prepare("SELECT * FROM brainstorm_cards WHERE id=?").get(id);
      if (previous && previous.roomId !== roomId) throw missing();
      if ((previous?.revision ?? 0) !== input.revision || previous?.deleted) throw changed();
      if (
        !previous &&
        Number(
          db
            .prepare("SELECT count(*) n FROM brainstorm_cards WHERE roomId=? AND deleted=0")
            .get(roomId)?.n,
        ) >= 200
      )
        throw new HubError(409, "BOARD_LIMIT", "На доске уже 200 карточек.");
      if (input.fileId) this.chat.publishFile(actor, roomId, input.fileId);
      const file = input.fileId ? this.chat.readFile(actor, roomId, input.fileId) : null;
      const user = this.team.registry.user(actor),
        updatedAt = Date.now();
      const card: BrainstormCard = {
        ...input,
        ...(file ? { file: { name: file.name, mime: file.mime, bytes: file.bytes } } : {}),
        id,
        revision: input.revision + 1,
        author: { id: user.id, name: user.name },
        updatedAt,
      };
      db.prepare(
        "INSERT INTO brainstorm_cards VALUES(?,?,?,0,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,value=excluded.value",
      ).run(id, roomId, card.revision, JSON.stringify(card));
      this.change(roomId, id);
      return card;
    });
  }
  remove(actor: string, roomId: string, id: string, key: string, revision: number) {
    this.access(actor, roomId, true);
    return this.team.once(
      actor,
      "brainstorm.remove:" + roomId + ":" + id,
      key,
      { revision },
      () => {
        const row = this.team.db
          .prepare("SELECT * FROM brainstorm_cards WHERE id=? AND roomId=?")
          .get(id, roomId);
        if (!row) throw missing();
        if (row.revision !== revision || row.deleted) throw changed();
        this.team.db
          .prepare("UPDATE brainstorm_cards SET deleted=1,revision=revision+1 WHERE id=?")
          .run(id);
        this.change(roomId, id);
        return { removed: true };
      },
    );
  }
  private change(roomId: string, id: string) {
    this.team.db
      .prepare("INSERT INTO brainstorm_changes(roomId,cardId) VALUES(?,?)")
      .run(roomId, id);
    this.team.db
      .prepare(
        "DELETE FROM brainstorm_changes WHERE roomId=? AND seq NOT IN (SELECT seq FROM brainstorm_changes WHERE roomId=? ORDER BY seq DESC LIMIT 400)",
      )
      .run(roomId, roomId);
    this.team.db
      .prepare("UPDATE brainstorm_rooms SET updatedAt=? WHERE id=?")
      .run(Date.now(), roomId);
  }
  context(actor: string, id: string) {
    const room = this.view(actor, id);
    const cards: BrainstormCard[] = this.team.db
      .prepare(
        "SELECT value FROM brainstorm_cards WHERE roomId=? AND deleted=0 ORDER BY rowid DESC LIMIT 60",
      )
      .all(id)
      .map((r) => JSON.parse(String(r.value)));
    const messages = this.chat
      .page(actor, id, {})
      .messages.slice(-12)
      .map((m) => ({ author: m.author.name, text: m.text.slice(0, 1000), files: m.files }));
    return JSON.stringify({
      room: { id, title: room.title, description: room.description },
      cards: cards.map((c) => ({
        id: c.id,
        title: c.title,
        text: c.text.slice(0, 1000),
        url: c.url,
        fileId: c.fileId,
      })),
      messages,
    }).slice(0, 24000);
  }
  snapshot(
    actor: string,
    id: string,
    key: string,
    input: {
      title: string;
      cardIds: string[];
      messageIds: string[];
      participants: BrainstormConversion["participants"];
      summary: string;
    },
  ) {
    this.access(actor, id, true, true);
    return this.team.once(actor, "brainstorm.snapshot:" + id, key, input, () => {
      if (
        Number(
          this.team.db
            .prepare("SELECT count(*) n FROM brainstorm_conversions WHERE roomId=?")
            .get(id)?.n,
        ) >= 100
      )
        throw new HubError(409, "ROOM_SNAPSHOT_LIMIT", "В комнате уже 100 снимков.");
      for (const person of input.participants) {
        this.team.registry.active(person.userId);
        if (person.userId === actor) throw changed();
      }
      const cards = input.cardIds.map((cardId) => {
        const row = this.team.db
          .prepare("SELECT value FROM brainstorm_cards WHERE roomId=? AND id=? AND deleted=0")
          .get(id, cardId);
        if (!row) throw changed();
        return JSON.parse(String(row.value)) as BrainstormCard;
      });
      const messages = this.chat
        .page(actor, id, {})
        .messages.filter((m) => input.messageIds.includes(m.id));
      if (messages.length !== input.messageIds.length) throw changed();
      const value: BrainstormConversion = {
        id: key,
        roomId: id,
        title: input.title,
        createdAt: Date.now(),
        projectId: null,
        spaceId: null,
        participants: input.participants,
        summary: input.summary,
        snapshot: { room: this.view(actor, id), cards, messages },
      };
      this.team.db
        .prepare("INSERT INTO brainstorm_conversions VALUES(?,?,?,?)")
        .run(key, id, actor, JSON.stringify(value));
      return value;
    });
  }
  conversion(actor: string, id: string): BrainstormConversion {
    this.team.registry.active(actor);
    const row = this.team.db
      .prepare("SELECT value FROM brainstorm_conversions WHERE id=? AND ownerId=?")
      .get(id, actor);
    if (!row) throw missing();
    const value = JSON.parse(String(row.value));
    this.access(actor, value.roomId);
    return value;
  }
}

/** Bounded shared metadata only; personal summaries never enter another account. */
export function brainstormSnapshotContext(snapshot: BrainstormConversion["snapshot"]) {
  let remaining = 16000;
  const take = (text: string, cap = 1500) => {
    const value = text.slice(0, Math.max(0, Math.min(cap, remaining)));
    remaining -= value.length;
    return value;
  };
  return {
    room: {
      id: snapshot.room.id,
      title: snapshot.room.title,
      description: take(snapshot.room.description),
    },
    cards: snapshot.cards.slice(0, 60).map((c) => ({
      id: c.id,
      title: take(c.title, 180),
      text: take(c.text),
      url: take(c.url, 2000),
      fileId: c.fileId,
    })),
    messages: snapshot.messages.slice(-12).map((m) => ({
      author: m.author.name,
      text: take(m.text),
      files: m.files.map((f) => ({ id: f.id, name: f.name })),
    })),
  };
}
