import { createHash } from "node:crypto";
import {
  type ActivityAttention,
  type ActivityDiscussionPage,
  type ActivityReaction,
  type ActivitySocialSummary,
  type GitHubActivitySource,
  HubError,
} from "@codex-web/shared";
import type { CollaborationSpaces } from "./collaboration-spaces.js";

export type ActivityScope = {
  spaceId: string;
  projectId: string;
  repositoryId: number;
  source: GitHubActivitySource;
};
const missing = () => new HubError(404, "ACTIVITY_UNAVAILABLE", "Обсуждение недоступно.");
/** Local social state. Callers must authorize the exact repository before reading content. */
export class ActivitySocial {
  constructor(private spaces: CollaborationSpaces) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS activity_topics(id TEXT PRIMARY KEY, spaceId TEXT NOT NULL REFERENCES collaboration_spaces(id) ON DELETE CASCADE, projectId TEXT NOT NULL, repositoryId INTEGER NOT NULL, source TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS activity_reactions(topic TEXT NOT NULL REFERENCES activity_topics(id) ON DELETE CASCADE, userId TEXT NOT NULL REFERENCES team_users(id), kind TEXT NOT NULL, PRIMARY KEY(topic,userId));
      CREATE TABLE IF NOT EXISTS activity_replies(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, topic TEXT NOT NULL REFERENCES activity_topics(id) ON DELETE CASCADE, authorId TEXT NOT NULL REFERENCES team_users(id), text TEXT NOT NULL, at INTEGER NOT NULL, replyTo INTEGER, recipientId TEXT);
      CREATE INDEX IF NOT EXISTS activity_replies_topic ON activity_replies(topic,seq);
      CREATE TABLE IF NOT EXISTS activity_attention(userId TEXT NOT NULL REFERENCES team_users(id), seq INTEGER NOT NULL REFERENCES activity_replies(seq) ON DELETE CASCADE, PRIMARY KEY(userId,seq));
    `);
  }
  private get db() {
    return this.spaces.team.db;
  }
  private person(id: string) {
    const u = this.spaces.team.registry.user(id);
    return { id: u.id, name: u.name };
  }
  id(s: ActivityScope) {
    return createHash("sha256")
      .update(JSON.stringify([s.spaceId, s.projectId, s.repositoryId, s.source.key]))
      .digest("hex");
  }
  source(
    spaceId: string,
    projectId: string,
    repositoryId: number,
    source: string,
  ): GitHubActivitySource | undefined {
    const row = this.db
      .prepare(
        "SELECT data FROM activity_topics WHERE spaceId=? AND projectId=? AND repositoryId=? AND source=?",
      )
      .get(spaceId, projectId, repositoryId, source);
    return row ? JSON.parse(String(row.data)) : undefined;
  }
  private ensure(s: ActivityScope) {
    this.db
      .prepare("INSERT OR IGNORE INTO activity_topics VALUES(?,?,?,?,?,?)")
      .run(
        this.id(s),
        s.spaceId,
        s.projectId,
        s.repositoryId,
        s.source.key,
        JSON.stringify(s.source),
      );
  }
  private access(actor: string, s: ActivityScope) {
    const space = this.spaces.access(actor, s.spaceId),
      project = space.projects.find((p) => p.id === s.projectId);
    if (!project || (!project.grants[actor] && project.ownerId !== actor) || !project.copies[actor])
      throw missing();
    return { space, project };
  }
  summary(actor: string, s: ActivityScope): ActivitySocialSummary {
    this.access(actor, s);
    const id = this.id(s);
    return {
      replies: Number(
        this.db.prepare("SELECT count(*) n FROM activity_replies WHERE topic=?").get(id)!.n,
      ),
      reactions: this.db
        .prepare(
          "SELECT kind,count(*) count,MAX(userId=?) mine FROM activity_reactions WHERE topic=? GROUP BY kind",
        )
        .all(actor, id)
        .map((r) => ({ kind: r.kind as ActivityReaction, count: Number(r.count), mine: !!r.mine })),
    };
  }
  page(actor: string, s: ActivityScope, before = Number.MAX_SAFE_INTEGER): ActivityDiscussionPage {
    this.access(actor, s);
    const rows = this.db
      .prepare("SELECT * FROM activity_replies WHERE topic=? AND seq<? ORDER BY seq DESC LIMIT 21")
      .all(this.id(s), before);
    return {
      projectId: s.projectId,
      repositoryId: s.repositoryId,
      source: s.source,
      summary: this.summary(actor, s),
      more: rows.length > 20,
      replies: rows
        .slice(0, 20)
        .reverse()
        .map((r) => ({
          seq: Number(r.seq),
          id: String(r.id),
          author: this.person(String(r.authorId)),
          text: String(r.text),
          at: Number(r.at),
          replyTo: r.replyTo === null ? null : Number(r.replyTo),
          recipient: r.recipientId ? this.person(String(r.recipientId)) : null,
        })),
    };
  }
  react(actor: string, s: ActivityScope, key: string, kind: ActivityReaction | null) {
    this.access(actor, s);
    this.spaces.team.once(actor, "activity.react:" + this.id(s), key, { kind }, () => {
      this.ensure(s);
      if (kind)
        this.db
          .prepare(
            "INSERT INTO activity_reactions VALUES(?,?,?) ON CONFLICT(topic,userId) DO UPDATE SET kind=excluded.kind",
          )
          .run(this.id(s), actor, kind);
      else
        this.db
          .prepare("DELETE FROM activity_reactions WHERE topic=? AND userId=?")
          .run(this.id(s), actor);
      return {};
    });
    return this.summary(actor, s);
  }
  reply(
    actor: string,
    s: ActivityScope,
    key: string,
    input: { text: string; replyTo?: number; recipientId?: string },
  ) {
    const { space, project } = this.access(actor, s);
    return this.spaces.team.once(actor, "activity.reply:" + this.id(s), key, input, () => {
      let recipient = input.recipientId;
      if (input.replyTo) {
        const parent = this.db
          .prepare("SELECT authorId FROM activity_replies WHERE topic=? AND seq=?")
          .get(this.id(s), input.replyTo);
        if (!parent || (recipient && recipient !== parent.authorId)) throw missing();
        recipient = String(parent.authorId);
      }
      if (recipient) {
        this.spaces.team.registry.active(recipient);
        if (
          !space.members.includes(recipient) ||
          (!project.grants[recipient] && project.ownerId !== recipient)
        )
          throw missing();
      }
      this.ensure(s);
      const seq = Number(
        this.db
          .prepare(
            "INSERT INTO activity_replies(id,topic,authorId,text,at,replyTo,recipientId) VALUES(?,?,?,?,?,?,?)",
          )
          .run(
            key,
            this.id(s),
            actor,
            input.text,
            Date.now(),
            input.replyTo ?? null,
            recipient ?? null,
          ).lastInsertRowid,
      );
      if (recipient && recipient !== actor)
        this.db.prepare("INSERT INTO activity_attention VALUES(?,?)").run(recipient, seq);
      return { seq };
    });
  }
  attention(actor: string, spaceId: string): ActivityAttention[] {
    const space = this.spaces.access(actor, spaceId);
    // Counts and generic address metadata are cheap; private source/body wait for native authorization.
    return this.db
      .prepare(
        `SELECT r.seq,r.authorId,r.at,t.projectId FROM activity_attention a JOIN activity_replies r ON r.seq=a.seq JOIN activity_topics t ON t.id=r.topic WHERE a.userId=? AND t.spaceId=? ORDER BY r.seq DESC LIMIT 100`,
      )
      .all(actor, spaceId)
      .filter((r) =>
        space.projects.some(
          (p) =>
            p.id === r.projectId && p.copies[actor] && (p.ownerId === actor || p.grants[actor]),
        ),
      )
      .map((r) => ({
        id: Number(r.seq),
        projectId: String(r.projectId),
        author: this.person(String(r.authorId)),
        at: Number(r.at),
      }));
  }
  notification(actor: string, spaceId: string, seq: number): ActivityScope {
    this.spaces.access(actor, spaceId);
    const row = this.db
      .prepare(
        `SELECT t.* FROM activity_attention a JOIN activity_replies r ON r.seq=a.seq JOIN activity_topics t ON t.id=r.topic WHERE a.userId=? AND a.seq=? AND t.spaceId=?`,
      )
      .get(actor, seq, spaceId);
    if (!row) throw missing();
    const s = {
      spaceId,
      projectId: String(row.projectId),
      repositoryId: Number(row.repositoryId),
      source: JSON.parse(String(row.data)),
    };
    this.access(actor, s);
    return s;
  }
  markRead(actor: string, s: ActivityScope, seqs: number[]) {
    this.access(actor, s);
    for (const seq of seqs)
      this.db
        .prepare(
          "DELETE FROM activity_attention WHERE userId=? AND seq=? AND seq IN (SELECT seq FROM activity_replies WHERE topic=?)",
        )
        .run(actor, seq, this.id(s));
  }
}
