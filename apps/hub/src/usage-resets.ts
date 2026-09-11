import { createHash, randomUUID } from "node:crypto";
import {
  HubError,
  type ResetOperation,
  type ResetOutcome,
  type UsageLimitsData,
} from "@codex-web/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Sessions } from "./sessions.js";
import { normalizeLimits } from "./usage.js";

type Connection = Awaited<ReturnType<Sessions["usageConnection"]>>;
type Snapshot = {
  machineId: string;
  accountKey: string;
  revision: number;
  fingerprint: string;
  expires: number;
};
type Receipt = ResetOperation & {
  accountKey: string;
  fingerprint: string;
  creditId: string | null;
  createdAt: number;
  updatedAt: number;
};
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const identity = (v: unknown) => (typeof v === "string" && v.trim() && v.length <= 2048 ? v : null);
const fingerprint = (v: UsageLimitsData) => hash({ groups: v.groups, credits: v.resetCredits });
const publicReceipt = (r: Receipt): ResetOperation => ({
  id: r.id,
  machineId: r.machineId,
  state: r.state,
  outcome: r.outcome,
});
const outcomes: ResetOutcome[] = ["reset", "alreadyRedeemed", "nothingToReset", "noCredit"];
function fail(code: string, message: string): never {
  throw new HubError(409, code, message);
}

export class UsageResets {
  private snapshots = new Map<string, Snapshot>();
  private running = new Set<string>();
  constructor(
    readonly sessions: Sessions,
    readonly now = () => Date.now(),
  ) {
    // The request can have succeeded remotely before the Hub stopped.
    this.db
      .prepare("UPDATE usage_reset_operations SET state='unknown' WHERE state='pending'")
      .run();
  }
  private get db() {
    return this.sessions.store.db;
  }
  private revision(accountKey: string) {
    return Number(
      this.db
        .prepare("SELECT revision FROM usage_reset_accounts WHERE accountKey=?")
        .get(accountKey)?.revision ?? 0,
    );
  }
  private epoch() {
    return Number(
      this.db.prepare("SELECT COALESCE(SUM(revision),0) n FROM usage_reset_accounts").get()!.n,
    );
  }
  private bump(accountKey: string) {
    this.db
      .prepare(
        "INSERT INTO usage_reset_accounts VALUES(?,1) ON CONFLICT(accountKey) DO UPDATE SET revision=revision+1",
      )
      .run(accountKey);
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  private async readNative(c: Connection) {
    const raw = await c.read();
    let key = identity(raw.accountId);
    if (key) key = "account:" + key;
    else if (obj(raw.rateLimitResetCredits).availableCount !== undefined) {
      const account = obj((await c.account().catch(() => ({}) as Record<string, unknown>)).account);
      const id = identity(account.id) ?? identity(account.accountId);
      // Email can be shared by multiple workspaces; it cannot bind a quota mutation.
      key = id ? "account:" + id : null;
    }
    return { data: normalizeLimits(raw), accountKey: key ? hash(key) : null };
  }
  private active(accountKey: string): Receipt | undefined {
    return this.db
      .prepare(
        "SELECT * FROM usage_reset_operations WHERE accountKey=? AND state IN ('pending','unknown') LIMIT 1",
      )
      .get(accountKey) as Receipt | undefined;
  }
  private receipt(id: string): Receipt | undefined {
    return this.db.prepare("SELECT * FROM usage_reset_operations WHERE id=?").get(id) as
      | Receipt
      | undefined;
  }
  get(machineId: string, id: string): ResetOperation {
    const r = this.receipt(id);
    if (!r || r.machineId !== machineId)
      throw new HubError(404, "RESET_ATTEMPT_MISSING", "Эта попытка сброса не зарегистрирована.");
    return publicReceipt(r);
  }
  async read(machineId: string): Promise<UsageLimitsData> {
    const before = this.epoch();
    const c = await this.sessions.usageConnection(machineId);
    let native: Awaited<ReturnType<UsageResets["readNative"]>>;
    try {
      native = await this.readNative(c);
    } catch {
      throw new HubError(503, "LIMITS_UNAVAILABLE", "Лимиты сейчас недоступны.");
    }
    const { data, accountKey } = native;
    if (!data.resetCredits) return data;
    if (!accountKey)
      return {
        ...data,
        resetContext: null,
        resetUnavailable: "Codex не подтвердил аккаунт для активации сброса.",
      };
    const op =
      this.active(accountKey) ??
      (this.db
        .prepare(
          "SELECT * FROM usage_reset_operations WHERE accountKey=? ORDER BY rowid DESC LIMIT 1",
        )
        .get(accountKey) as Receipt | undefined);
    const resetOperation =
      op && (op.state !== "complete" || op.updatedAt > this.now() - 600000)
        ? publicReceipt(op)
        : null;
    if (op && op.outcome === "unsupported" && op.updatedAt > this.now() - 60000)
      return {
        ...data,
        resetContext: null,
        resetOperation,
        resetUnavailable: "Эта версия Codex не поддерживает активацию сброса.",
      };
    // A read overlapping a redemption cannot authorize another redemption.
    if (before !== this.epoch() || (op && op.state !== "complete"))
      return { ...data, resetContext: null, resetOperation };
    for (const [id, s] of this.snapshots) if (s.expires <= this.now()) this.snapshots.delete(id);
    while (this.snapshots.size >= 200) this.snapshots.delete(this.snapshots.keys().next().value!);
    const id = randomUUID();
    this.snapshots.set(id, {
      machineId,
      accountKey,
      revision: this.revision(accountKey),
      fingerprint: fingerprint(data),
      expires: this.now() + 600000,
    });
    return { ...data, resetContext: id, resetOperation };
  }
  private validateCredit(data: UsageLimitsData, creditId?: string) {
    const summary = data.resetCredits;
    if (!summary || summary.availableCount <= 0)
      fail("RESET_CREDIT_UNAVAILABLE", "Доступных сбросов больше нет. Обнови лимиты.");
    if (creditId === undefined) {
      if (summary.credits !== null)
        fail("RESET_CREDIT_REQUIRED", "Выбери доступный сброс из обновлённого списка.");
      return;
    }
    const c = summary.credits?.find((v) => v.id === creditId);
    if (
      !c ||
      c.status !== "available" ||
      c.resetType !== "codexRateLimits" ||
      (c.expiresAt !== null && c.expiresAt * 1000 <= this.now())
    )
      fail("RESET_CREDIT_UNAVAILABLE", "Этот сброс уже недоступен. Обнови лимиты.");
  }
  async consume(
    machineId: string,
    input: { id: string; snapshotId: string; creditId?: string },
  ): Promise<ResetOperation> {
    const requestFingerprint = hash({
      machineId,
      snapshotId: input.snapshotId,
      creditId: input.creditId ?? null,
    });
    const previous = this.receipt(input.id);
    if (previous) {
      if (previous.fingerprint !== requestFingerprint || previous.machineId !== machineId)
        fail("RESET_KEY_REUSED", "Эта попытка относится к другому сбросу.");
      return publicReceipt(previous); // Only the explicit retry route can repeat the native RPC.
    }
    const snapshot = this.snapshots.get(input.snapshotId);
    if (!snapshot || snapshot.machineId !== machineId || snapshot.expires <= this.now())
      fail("RESET_SNAPSHOT_EXPIRED", "Обнови лимиты перед активацией сброса.");
    const c = await this.sessions.usageConnection(machineId);
    const latest = await this.readNative(c);
    if (!latest.accountKey || latest.accountKey !== snapshot.accountKey)
      fail("RESET_ACCOUNT_CHANGED", "Аккаунт Codex изменился. Обнови лимиты.");
    if (snapshot.fingerprint !== fingerprint(latest.data))
      fail(
        "RESET_LIMITS_CHANGED",
        "Лимиты или доступные сбросы изменились. Обнови их перед подтверждением.",
      );
    this.validateCredit(latest.data, input.creditId);
    const reserved = this.transaction(() => {
      const duplicate = this.receipt(input.id);
      if (duplicate) {
        if (duplicate.fingerprint !== requestFingerprint)
          fail("RESET_KEY_REUSED", "Эта попытка относится к другому сбросу.");
        return false;
      }
      if (this.active(snapshot.accountKey))
        fail("RESET_PENDING", "Сначала проверь предыдущую попытку сброса.");
      if (
        this.revision(snapshot.accountKey) !== snapshot.revision ||
        snapshot.expires <= this.now()
      )
        fail("RESET_LIMITS_CHANGED", "Данные изменились на другом устройстве. Обнови лимиты.");
      this.db
        .prepare("INSERT INTO usage_reset_operations VALUES(?,?,?,?,?,'pending',NULL,?,?)")
        .run(
          input.id,
          machineId,
          snapshot.accountKey,
          requestFingerprint,
          input.creditId ?? null,
          this.now(),
          this.now(),
        );
      this.bump(snapshot.accountKey);
      return true;
    });
    if (!reserved) return publicReceipt(this.receipt(input.id)!);
    return this.dispatch(c, this.receipt(input.id)!);
  }
  async retry(machineId: string, id: string): Promise<ResetOperation> {
    this.get(machineId, id);
    const r = this.receipt(id)!;
    if (r.state === "complete" || this.running.has(id) || r.state === "pending")
      return publicReceipt(r);
    const c = await this.sessions.usageConnection(machineId);
    // Refresh first; a changed count/percentage alone never proves this attempt succeeded.
    const latest = await this.readNative(c);
    if (!latest.accountKey || latest.accountKey !== r.accountKey)
      fail("RESET_ACCOUNT_CHANGED", "Верни исходный аккаунт Codex для проверки этой попытки.");
    if (this.running.has(id) || this.receipt(id)!.state !== "unknown")
      return publicReceipt(this.receipt(id)!);
    this.transaction(() => {
      this.db
        .prepare("UPDATE usage_reset_operations SET state='pending',updatedAt=? WHERE id=?")
        .run(this.now(), id);
      this.bump(r.accountKey);
    });
    return this.dispatch(c, r);
  }
  private async dispatch(c: Connection, r: Receipt): Promise<ResetOperation> {
    this.running.add(r.id);
    let outcome: ResetOutcome | null = null;
    try {
      const response = await c.consume(r.id, r.creditId ?? undefined);
      if (outcomes.includes(response.outcome as ResetOutcome))
        outcome = response.outcome as ResetOutcome;
    } catch (e) {
      if (e instanceof HubError && e.code === "CODEX_METHOD_UNSUPPORTED") outcome = "unsupported";
    } finally {
      this.running.delete(r.id);
    }
    this.transaction(() => {
      this.db
        .prepare("UPDATE usage_reset_operations SET state=?,outcome=?,updatedAt=? WHERE id=?")
        .run(outcome ? "complete" : "unknown", outcome, this.now(), r.id);
      this.bump(r.accountKey);
    });
    return publicReceipt(this.receipt(r.id)!);
  }
}

export function registerUsageResets(app: FastifyInstance, sessions: Sessions) {
  const service = new UsageResets(sessions);
  const params = z.object({ id: z.string().min(1).max(100) });
  const attempt = params.extend({ attempt: z.string().uuid() });
  const confirm = z.object({ confirm: z.literal(true) }).strict();
  app.get("/api/machines/:id/limits", (req) => service.read(params.parse(req.params).id));
  app.get("/api/machines/:id/limits/resets/:attempt", (req) => {
    const p = attempt.parse(req.params);
    return service.get(p.id, p.attempt);
  });
  app.post("/api/machines/:id/limits/resets", (req) => {
    const body = confirm
      .extend({
        id: z.string().uuid(),
        snapshotId: z.string().uuid(),
        creditId: z.string().min(1).max(1024).optional(),
      })
      .parse(req.body);
    return service.consume(params.parse(req.params).id, body);
  });
  app.post("/api/machines/:id/limits/resets/:attempt/retry", (req) => {
    confirm.parse(req.body);
    const p = attempt.parse(req.params);
    return service.retry(p.id, p.attempt);
  });
  return service;
}
