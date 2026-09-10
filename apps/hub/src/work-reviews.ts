import { createHash } from "node:crypto";
import {
  HubError,
  type ProjectAction,
  type ReviewDecision,
  type ReviewEvidence,
  type ReviewPage,
  type ReviewSummary,
  type WorkReview,
} from "@codex-web/shared";
import type { GptService } from "./gpt.js";
import { projectKey } from "./project-core.js";
import type { Sessions } from "./sessions.js";

/** Frozen, bounded observations. Owner acceptance is independent of check outcomes. */
export class WorkReviews {
  constructor(
    readonly sessions: Sessions,
    readonly gpt: GptService,
  ) {}
  private get db() {
    return this.sessions.store.db;
  }
  get(id: string): WorkReview {
    const row = this.db.prepare("SELECT value FROM work_reviews WHERE id=?").get(id);
    if (!row) throw new HubError(404, "REVIEW_MISSING", "Приёмка этой работы ещё не доступна.");
    return JSON.parse(String(row.value));
  }
  capture(action: ProjectAction): WorkReview | null {
    if (
      action.state !== "completed" ||
      !["plan", "correction"].includes(action.kind) ||
      !action.threadId
    )
      return null;
    const existing = this.db.prepare("SELECT value FROM work_reviews WHERE id=?").get(action.id);
    if (existing) return JSON.parse(String(existing.value));
    let answer = "",
      source = action.source,
      evidence: ReviewEvidence[] = [],
      total = 0;
    if (action.scope.client === "codex") {
      if (!action.turnId) return null;
      const terminal = this.db
        .prepare(
          "SELECT payload FROM events WHERE threadId=? AND turnId=? AND type='turn.completed' ORDER BY seq DESC LIMIT 1",
        )
        .get(action.threadId, action.turnId);
      if (!terminal || JSON.parse(String(terminal.payload)).status !== "completed") return null;
      const messages = this.db
        .prepare(
          "SELECT id,text FROM messages WHERE threadId=? AND turnId=? AND role='assistant' AND phase='final' ORDER BY firstSeq LIMIT 20",
        )
        .all(action.threadId, action.turnId);
      answer = messages.map((m) => String(m.text)).join("\n\n");
      if (messages.length)
        source = {
          client: "codex",
          kind: "thread",
          id: action.threadId,
          threadId: action.threadId,
          turnId: action.turnId,
          messageId: String(messages.at(-1)!.id),
          projectId: action.scope.projectId,
          title: action.title,
        };
      const rows = this.db
        .prepare(
          "SELECT id,title,type,payload,sourceKey FROM results WHERE threadId=? AND turnId=? ORDER BY rowid LIMIT 80",
        )
        .all(action.threadId, action.turnId);
      total = Number(
        this.db
          .prepare("SELECT count(*) n FROM results WHERE threadId=? AND turnId=?")
          .get(action.threadId, action.turnId)?.n ?? 0,
      );
      evidence = rows.map((r) => {
        const p = JSON.parse(String(r.payload));
        const code =
          typeof p.exitCode === "number" && Number.isInteger(p.exitCode) ? p.exitCode : undefined;
        return {
          id: String(r.id),
          title: String(r.title).slice(0, 200),
          type: String(r.type),
          target: {
            client: "codex",
            kind: "result",
            id: String(r.id),
            threadId: action.threadId!,
            turnId: action.turnId,
            projectId: action.scope.projectId,
            title: String(r.title).slice(0, 200),
          },
          ...(r.type === "check" && typeof p.command === "string"
            ? { command: p.command.slice(0, 2000), exitCode: code }
            : {}),
          status:
            r.type === "check" && code !== undefined
              ? code === 0
                ? "passed"
                : "failed"
              : "unknown",
        };
      });
    } else {
      const job = this.gpt.job(action.id);
      if (job.status !== "completed" || !job.nativeId || job.nativeId !== action.threadId)
        return null;
      answer = job.answer;
      total = job.assets.length;
      evidence = job.assets.slice(0, 80).map((a) => ({
        id: a.id,
        title: a.name,
        type: a.image ? "image" : "file",
        status: "unknown",
        target: {
          client: "gpt",
          kind: "result",
          id: a.id,
          title: a.name.slice(0, 200),
          threadId: action.threadId!,
          projectId: action.scope.projectId,
        },
      }));
    }
    // Completion may arrive just before its final projection. Capture once evidence exists.
    if (!answer.trim() && !total) return null;
    const cached = (
      this.sessions.store.preferences().projectGit as
        | Record<string, Record<string, unknown>>
        | undefined
    )?.[action.scope.projectId];
    let git: WorkReview["git"];
    if (
      action.scope.client === "codex" &&
      cached?.root === this.sessions.project(action.scope.projectId).workingDirectory &&
      typeof cached.checkedAt === "number"
    )
      git = {
        branch: typeof cached.branch === "string" ? cached.branch : undefined,
        changed: Number(cached.changed ?? 0),
        checkedAt: cached.checkedAt,
      };
    const snapshot = action.snapshot.plan as
      | { id: string; revision: number; title: string }
      | undefined;
    const value: WorkReview = {
      id: action.id,
      actionId: action.id,
      scope: action.scope,
      title: action.title,
      state: "pending",
      revision: 1,
      note: "",
      createdAt: Date.now(),
      threadId: action.threadId,
      ...(action.scope.client === "codex" ? { turnId: action.turnId } : { jobId: action.id }),
      source,
      answer: answer.slice(0, 48000),
      answerTruncated: answer.length > 48000,
      evidence,
      evidenceTotal: total,
      ...(snapshot
        ? { plan: { id: snapshot.id, revision: snapshot.revision, title: snapshot.title } }
        : {}),
      ...(git ? { git } : {}),
      ...(action.reviewId ? { parentReviewId: action.reviewId } : {}),
    };
    this.db
      .prepare("INSERT OR IGNORE INTO work_reviews VALUES(?,?,?,?,?,?,?,?)")
      .run(
        value.id,
        projectKey(value.scope),
        value.threadId,
        value.turnId ?? null,
        value.state,
        1,
        JSON.stringify(value),
        value.createdAt,
      );
    return this.get(value.id);
  }
  summary(value: WorkReview): ReviewSummary {
    const { answer: _answer, evidence, ...rest } = value;
    return {
      ...rest,
      passed: evidence.filter((r) => r.status === "passed").length,
      failed: evidence.filter((r) => r.status === "failed").length,
    };
  }
  list(scope = "all", offset = 0, threadId = ""): ReviewPage {
    const rows = this.db
      .prepare(
        "SELECT value FROM work_reviews WHERE (?='all' OR scopeKey=?) AND (?='' OR threadId=?) ORDER BY createdAt DESC,id LIMIT 21 OFFSET ?",
      )
      .all(scope, scope, threadId, threadId, offset);
    return {
      items: rows.slice(0, 20).map((r) => this.summary(JSON.parse(String(r.value)))),
      nextOffset: rows.length > 20 ? offset + 20 : null,
    };
  }
  decide(id: string, input: ReviewDecision) {
    const fingerprint = createHash("sha256")
      .update(JSON.stringify({ id, ...input }))
      .digest("hex");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const receipt = this.db
        .prepare("SELECT * FROM work_review_receipts WHERE id=?")
        .get(input.requestId);
      if (receipt) {
        if (receipt.fingerprint !== fingerprint)
          throw new HubError(
            409,
            "REVIEW_KEY_REUSED",
            "Подтверждение относится к другому решению.",
          );
        this.db.exec("COMMIT");
        return JSON.parse(String(receipt.response)) as WorkReview;
      }
      const value = this.get(id);
      if (value.revision !== input.revision)
        throw new HubError(
          409,
          "REVIEW_CONFLICT",
          "Решение изменилось на другом устройстве. Обнови приёмку; замечание сохранено.",
        );
      const next: WorkReview = {
        ...value,
        revision: value.revision + 1,
        state: input.decision,
        note: input.note,
        decidedAt: Date.now(),
      };
      this.db
        .prepare("UPDATE work_reviews SET value=?,state=?,revision=? WHERE id=?")
        .run(JSON.stringify(next), next.state, next.revision, id);
      this.db
        .prepare("INSERT INTO work_review_receipts VALUES(?,?,?,?)")
        .run(input.requestId, id, fingerprint, JSON.stringify(next));
      this.db.exec("COMMIT");
      return next;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
}
