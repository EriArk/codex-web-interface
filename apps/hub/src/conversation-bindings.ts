import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  type ConversationBinding,
  type ConversationBindingSpec,
  HubError,
} from "@codex-web/shared";

const conflict = () =>
  new HubError(
    409,
    "CONVERSATION_ALREADY_BOUND",
    "Этот чат уже принадлежит другому проекту или назначению. Выбери отдельный чат.",
  );
const changed = () =>
  new HubError(
    409,
    "CONVERSATION_BINDING_CHANGED",
    "Привязка уже изменилась. Открой окно проекта снова; черновик сохранён.",
  );
const sameSpec = (a: ConversationBindingSpec, b: ConversationBindingSpec) =>
  a.lifecycle === b.lifecycle &&
  a.visibility === b.visibility &&
  a.execution?.machineId === b.execution?.machineId &&
  a.execution?.workingDirectory === b.execution?.workingDirectory;

/** One registry per private runtime. No native creation, deletion, discovery or authorization grants. */
export class ConversationBindings {
  constructor(
    private db: DatabaseSync,
    readonly ownerUserId: string,
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ai_conversation_bindings (
        id TEXT PRIMARY KEY, ownerUserId TEXT NOT NULL, provider TEXT NOT NULL,
        scope TEXT NOT NULL, scopeId TEXT NOT NULL, role TEXT NOT NULL,
        lifecycle TEXT NOT NULL, visibility TEXT NOT NULL, execution TEXT NOT NULL,
        nativeId TEXT, jobId TEXT, revision INTEGER NOT NULL,
        UNIQUE(ownerUserId,provider,scope,scopeId,role)
      );
      CREATE TABLE IF NOT EXISTS ai_conversation_binding_history (
        bindingId TEXT NOT NULL, revision INTEGER NOT NULL, value TEXT NOT NULL,
        reason TEXT NOT NULL, changedAt INTEGER NOT NULL, PRIMARY KEY(bindingId,revision)
      );
      CREATE TABLE IF NOT EXISTS ai_conversation_claims (
        ownerUserId TEXT NOT NULL, provider TEXT NOT NULL, nativeId TEXT NOT NULL,
        bindingId TEXT NOT NULL, PRIMARY KEY(ownerUserId,provider,nativeId,bindingId)
      );
    `);
    const foreign = db
      .prepare("SELECT 1 FROM ai_conversation_bindings WHERE ownerUserId<>? LIMIT 1")
      .get(ownerUserId);
    if (foreign) throw new Error("CONVERSATION_BINDING_OWNER_MISMATCH");
  }
  private id(spec: ConversationBindingSpec) {
    return createHash("sha256")
      .update(
        JSON.stringify([this.ownerUserId, spec.provider, spec.scope, spec.scopeId, spec.role]),
      )
      .digest("hex");
  }
  get(spec: ConversationBindingSpec): ConversationBinding | null {
    const row = this.db
      .prepare("SELECT * FROM ai_conversation_bindings WHERE id=? AND ownerUserId=?")
      .get(this.id(spec), this.ownerUserId);
    return row
      ? ({ ...row, execution: JSON.parse(String(row.execution)) } as ConversationBinding)
      : null;
  }
  private claim(value: ConversationBinding) {
    if (value.nativeId)
      this.db
        .prepare("INSERT OR IGNORE INTO ai_conversation_claims VALUES(?,?,?,?)")
        .run(this.ownerUserId, value.provider, value.nativeId, value.id);
  }
  assertExclusive(value: ConversationBinding, nativeId = value.nativeId) {
    if (
      nativeId &&
      this.db
        .prepare(
          "SELECT 1 FROM ai_conversation_claims WHERE ownerUserId=? AND provider=? AND nativeId=? AND bindingId<>? LIMIT 1",
        )
        .get(this.ownerUserId, value.provider, nativeId, value.id)
    )
      throw conflict();
  }
  private remember(value: ConversationBinding, reason: string) {
    this.db
      .prepare("INSERT OR REPLACE INTO ai_conversation_binding_history VALUES(?,?,?,?,?)")
      .run(value.id, value.revision, JSON.stringify(value), reason, Date.now());
    this.claim(value);
  }
  ensure(
    spec: ConversationBindingSpec,
    legacy?: { nativeId: string | null; jobId: string | null; revision: number },
  ) {
    const existing = this.get(spec);
    if (existing) {
      if (!sameSpec(existing, spec)) throw changed();
      return existing;
    }
    const value: ConversationBinding = {
      ...spec,
      id: this.id(spec),
      ownerUserId: this.ownerUserId,
      nativeId: null,
      jobId: null,
      revision: 0,
      ...legacy,
    };
    // Legacy duplicate claims are retained without guessing which project's memory is correct.
    // Dispatch remains blocked until the owner explicitly chooses separate conversations.
    this.db.exec("SAVEPOINT conversation_binding_insert");
    try {
      this.db
        .prepare("INSERT INTO ai_conversation_bindings VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(
          value.id,
          this.ownerUserId,
          value.provider,
          value.scope,
          value.scopeId,
          value.role,
          value.lifecycle,
          value.visibility,
          JSON.stringify(value.execution),
          value.nativeId,
          value.jobId,
          value.revision,
        );
      this.remember(value, legacy ? "legacy-project-gpt" : "created");
      this.db.exec("RELEASE conversation_binding_insert");
    } catch (error) {
      this.db.exec("ROLLBACK TO conversation_binding_insert; RELEASE conversation_binding_insert");
      throw error;
    }
    return value;
  }
  replace(spec: ConversationBindingSpec, expected: number, nativeId: string | null) {
    const current = this.get(spec) ?? this.ensure(spec);
    if (current.revision !== expected) throw changed();
    if (current.nativeId === nativeId && !current.jobId && sameSpec(current, spec)) {
      this.assertExclusive(current, nativeId);
      return current;
    }
    const value = { ...current, ...spec, nativeId, jobId: null, revision: current.revision + 1 };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.assertExclusive(current, nativeId);
      const updated = this.db
        .prepare(
          "UPDATE ai_conversation_bindings SET nativeId=?,jobId=NULL,revision=?,execution=?,lifecycle=?,visibility=? WHERE id=? AND revision=?",
        )
        .run(
          nativeId,
          value.revision,
          JSON.stringify(value.execution),
          value.lifecycle,
          value.visibility,
          value.id,
          expected,
        );
      if (updated.changes !== 1) throw changed();
      this.remember(value, "explicit-rebind");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return value;
  }
  /** Adopt only an exact durable job receipt; never search titles or select a recent chat. */
  recover(
    spec: ConversationBindingSpec,
    expected: number,
    nativeId: string | null,
    jobId: string | null,
  ) {
    const current = this.ensure(spec);
    if (current.revision !== expected) return current;
    if (current.nativeId && current.nativeId !== nativeId) throw conflict();
    if (current.nativeId === nativeId && current.jobId === jobId) return current;
    const value = { ...current, nativeId, jobId };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.assertExclusive(current, nativeId);
      const updated = this.db
        .prepare("UPDATE ai_conversation_bindings SET nativeId=?,jobId=? WHERE id=? AND revision=?")
        .run(nativeId, jobId, current.id, expected);
      if (updated.changes !== 1) throw changed();
      this.remember(value, "exact-job-receipt");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return value;
  }
}
