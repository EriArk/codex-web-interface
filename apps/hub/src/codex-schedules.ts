import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  type CodexSchedule,
  type CodexScheduleInput,
  type CodexScheduleList,
  type CodexScheduleRun,
  codexScheduleInputSchema,
  HubError,
} from "@codex-web/shared";
import { nextScheduleTime } from "./schedule-time.js";

export type ScheduleTarget = CodexScheduleList["target"] & {
  projectId: string;
  sourceThreadId?: string;
  stamp: string;
  nativeId?: string;
};
export type ScheduleDestination = { threadId: string; nativeId: string; revision: number };
export interface ScheduleDelivery {
  reconcile?(target: ScheduleTarget, run: CodexScheduleRun): Promise<void>;
  resolve(target: ScheduleTarget): ScheduleDestination;
  send(
    target: ScheduleTarget,
    run: CodexScheduleRun,
    text: string,
    commit: (destination: ScheduleDestination) => void,
  ): Promise<{ turnId: string }>;
}
type Saved = CodexSchedule & { target: ScheduleTarget; fingerprint: string; attemptAt?: number };
const digest = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
export const scheduleConflict = () =>
  new HubError(
    409,
    "SCHEDULE_CHANGED",
    "Расписание изменилось или уже отправляется. Обнови список; черновик сохранён.",
  );
const waiting = new Set([
  "WORKSPACE_CLOSING",
  "QUEUE_BUSY",
  "PROJECT_BUSY",
  "THREAD_IN_USE",
  "THREAD_STATE_UNKNOWN",
  "HANDOFF_PENDING",
  "MACHINE_RELEASED",
  "DELIVERY_BUSY",
  "ENTITY_BUSY",
  "ENGINE_MAINTENANCE",
  "WORKSPACE_RECONFIGURING",
  "SCHEDULE_BUSY",
]);

/** Durable, account-private outbox. Only beforeCommit crosses the send boundary. */
export class CodexSchedules {
  private pending?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private reconciled = new Map<string, number>();
  constructor(
    readonly db: DatabaseSync,
    readonly delivery: ScheduleDelivery,
    readonly now = Date.now,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS codex_schedules(id TEXT PRIMARY KEY,target TEXT NOT NULL,value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS codex_schedules_target ON codex_schedules(target);
      CREATE TABLE IF NOT EXISTS codex_schedule_runs(id TEXT PRIMARY KEY,scheduleId TEXT NOT NULL,dueAt INTEGER NOT NULL,value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS codex_schedule_runs_schedule ON codex_schedule_runs(scheduleId,dueAt);
      CREATE TABLE IF NOT EXISTS codex_schedule_receipts(id TEXT PRIMARY KEY,nativeId TEXT NOT NULL,turnId TEXT NOT NULL);`);
    for (const r of this.runs("running"))
      this.finish(r.scheduleId, {
        ...r.run,
        state: "unknown",
        error: "Подтверждение отправки потеряно. Автоматического повтора не будет.",
      });
  }
  start() {
    this.timer = setInterval(() => {
      void this.tick();
    }, 15000);
    this.timer.unref();
  }
  async close() {
    this.stopped = true;
    clearInterval(this.timer);
    await this.pending;
  }
  private saved(id: string): Saved {
    const row = this.db.prepare("SELECT value FROM codex_schedules WHERE id=?").get(id);
    if (!row) throw new HubError(404, "SCHEDULE_MISSING", "Расписание не найдено.");
    return JSON.parse(String(row.value));
  }
  private write(v: Saved) {
    this.db
      .prepare(
        "INSERT INTO codex_schedules VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
      )
      .run(v.id, v.target.key, JSON.stringify(v));
    return v;
  }
  private public(v: Saved): CodexSchedule {
    const { target: _target, fingerprint: _fingerprint, attemptAt: _attemptAt, ...value } = v;
    return value;
  }
  list(target: ScheduleTarget): CodexScheduleList {
    return {
      target: { key: target.key, name: target.name, role: target.role, revision: target.revision },
      items: this.db
        .prepare(
          "SELECT value FROM codex_schedules WHERE target=? ORDER BY CASE WHEN json_extract(value,'$.state') IN ('scheduled','paused') OR json_extract(value,'$.last.state')='unknown' THEN 0 ELSE 1 END,rowid DESC LIMIT 100",
        )
        .all(target.key)
        .map((r) => this.public(JSON.parse(String(r.value)))),
    };
  }
  create(id: string, target: ScheduleTarget, raw: unknown) {
    const input = codexScheduleInputSchema.parse(raw),
      fingerprint = digest([target.key, target.stamp, input]);
    const row = this.db.prepare("SELECT value FROM codex_schedules WHERE id=?").get(id);
    if (row) {
      const old: Saved = JSON.parse(String(row.value));
      if (old.fingerprint !== fingerprint) throw scheduleConflict();
      return this.public(old);
    }
    if (Number(this.db.prepare("SELECT count(*) AS n FROM codex_schedules").get()?.n) >= 1000)
      throw new HubError(409, "SCHEDULE_LIMIT", "Достигнут предел сохранённых расписаний.");
    const nextAt = nextScheduleTime(input.rule, this.now());
    if (
      Number(
        this.db
          .prepare(
            "SELECT count(*) n FROM codex_schedules WHERE target=? AND (json_extract(value,'$.state') IN ('scheduled','paused') OR json_extract(value,'$.last.state')='unknown')",
          )
          .get(target.key)?.n,
      ) >= 50
    )
      throw new HubError(409, "SCHEDULE_LIMIT", "В этом чате уже 50 действующих расписаний.");
    if (!nextAt) throw new HubError(400, "SCHEDULE_PAST", "Выбери время в будущем.");
    this.delivery.resolve(target);
    return this.public(
      this.write({ ...input, id, target, fingerprint, revision: 1, state: "scheduled", nextAt }),
    );
  }
  change(
    id: string,
    target: ScheduleTarget,
    revision: number,
    action: "edit" | "pause" | "resume" | "cancel",
    input?: CodexScheduleInput,
  ) {
    const v = this.saved(id);
    if (v.target.key !== target.key || v.revision !== revision || v.last?.state === "running")
      throw scheduleConflict();
    if (v.state === "cancelled") throw scheduleConflict();
    if (action === "edit") Object.assign(v, codexScheduleInputSchema.parse(input));
    if (action === "edit" || action === "resume") {
      // A changed machine/account binding requires a new schedule, never silent reauthorization.
      this.delivery.resolve(v.target);
      v.nextAt = nextScheduleTime(v.rule, this.now());
      if (!v.nextAt) throw new HubError(400, "SCHEDULE_PAST", "Выбери время в будущем.");
      v.state = "scheduled";
    } else {
      v.state = action === "pause" ? "paused" : "cancelled";
      v.nextAt = null;
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (v.last?.state === "waiting") {
        v.last = { ...v.last, state: "cancelled" };
        this.runWrite(v.id, v.last);
      }
      v.revision++;
      this.write(v);
      this.db.exec("COMMIT");
      return this.public(v);
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  private runWrite(id: string, run: CodexScheduleRun) {
    this.db
      .prepare(
        "INSERT INTO codex_schedule_runs VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
      )
      .run(run.id, id, run.dueAt, JSON.stringify(run));
  }
  private runs(state: string) {
    return this.db
      .prepare(
        "SELECT scheduleId,value FROM codex_schedule_runs WHERE json_extract(value,'$.state')=? ORDER BY dueAt LIMIT 100",
      )
      .all(state)
      .map((r) => ({
        scheduleId: String(r.scheduleId),
        run: JSON.parse(String(r.value)) as CodexScheduleRun,
      }));
  }
  private finish(id: string, run: CodexScheduleRun, pause = false) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const v = this.saved(id);
      this.runWrite(id, run);
      if (v.last?.id === run.id) {
        v.last = run;
        if (run.state !== "waiting" && run.state !== "running" && v.state === "scheduled") {
          v.nextAt = v.rule.weekdays.length
            ? nextScheduleTime(v.rule, Math.max(run.dueAt, this.now()))
            : null;
          if (!v.nextAt) v.state = "finished";
          if (pause) {
            v.state = "paused";
            v.nextAt = null;
          }
        }
        this.write(v);
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    if (
      ["failed", "unknown"].includes(run.state) &&
      run.threadId &&
      this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='push_notices'").get()
    )
      this.db
        .prepare("INSERT OR IGNORE INTO push_notices VALUES(?,?,'codex',?,'errors','schedule',?,0)")
        .run(
          digest(["schedule", run.id]).slice(0, 32),
          "schedule:" + run.id,
          run.threadId,
          this.now(),
        );
  }
  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (!this.pending)
      this.pending = this.work()
        .catch(() => {})
        .finally(() => {
          this.pending = undefined;
        });
    return this.pending;
  }
  private async work() {
    let reads = 0;
    for (const { scheduleId, run } of this.runs("unknown")) {
      if (
        this.delivery.reconcile &&
        reads < 5 &&
        (this.reconciled.get(run.id) ?? 0) <= this.now()
      ) {
        this.reconciled.set(run.id, this.now() + 60000);
        if (this.reconciled.size > 100)
          this.reconciled.delete(this.reconciled.keys().next().value!);
        reads++;
        await this.delivery.reconcile(this.saved(scheduleId).target, run).catch(() => {});
      }
      const receipt = this.db
        .prepare("SELECT nativeId,turnId FROM codex_schedule_receipts WHERE id=?")
        .get(run.id);
      if (receipt && receipt.nativeId === run.nativeId)
        this.finish(scheduleId, {
          ...run,
          state: "sent",
          turnId: String(receipt.turnId),
          error: undefined,
        });
    }
    const due = this.db
      .prepare(
        "SELECT value FROM (SELECT value,ROW_NUMBER() OVER (PARTITION BY target ORDER BY json_extract(value,'$.nextAt'),rowid) position FROM codex_schedules WHERE json_extract(value,'$.state')='scheduled' AND json_extract(value,'$.nextAt')<=?) WHERE position=1 ORDER BY COALESCE(json_extract(value,'$.attemptAt'),0),json_extract(value,'$.nextAt') LIMIT 20",
      )
      .all(this.now());
    const blocked = new Set<string>();
    for (const row of due) {
      if (this.stopped) break;
      const v = this.saved(JSON.parse(String(row.value)).id);
      if (v.state !== "scheduled" || v.nextAt === null || v.nextAt > this.now()) continue;
      if (blocked.has(v.target.key)) continue;
      const revision = v.revision;
      v.attemptAt = this.now();
      let run: CodexScheduleRun =
        v.last?.state === "waiting"
          ? v.last
          : {
              id: randomUUID(),
              dueAt: v.nextAt!,
              state: "waiting",
              threadId: v.target.sourceThreadId,
            };
      v.last = run;
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.write(v);
        this.runWrite(v.id, run);
        this.db.exec("COMMIT");
      } catch (e) {
        this.db.exec("ROLLBACK");
        throw e;
      }
      const check = () => {
        const current = this.saved(v.id);
        if (
          this.stopped ||
          current.revision !== revision ||
          current.state !== "scheduled" ||
          current.last?.id !== run.id
        )
          throw scheduleConflict();
        return this.delivery.resolve(v.target);
      };
      let committed = false;
      try {
        const destination = check();
        run = { ...run, ...destination };
        const result = await this.delivery.send(v.target, run, v.text, (actual) => {
          const resolved = check();
          if (JSON.stringify(resolved) !== JSON.stringify(actual)) throw scheduleConflict();
          run = { ...run, ...actual, state: "running" };
          this.finish(v.id, run);
          committed = true;
        });
        if (!committed || !result.turnId) throw new Error("Missing native acknowledgement");
        this.finish(v.id, { ...run, state: "sent", turnId: result.turnId });
      } catch (error) {
        if (!committed && this.saved(v.id).revision !== revision) continue;
        if (!committed && this.stopped) {
          this.finish(v.id, { ...run, state: "waiting" });
          continue;
        }
        const code =
          error instanceof HubError
            ? error.code
            : (error as { cause?: { code?: string } })?.cause?.code;
        if (!committed && waiting.has(code ?? "")) {
          blocked.add(v.target.key);
          this.finish(v.id, { ...run, state: "waiting" });
        } else {
          this.finish(
            v.id,
            {
              ...run,
              state: committed ? "unknown" : "failed",
              error: committed
                ? "Подтверждение не получено. Автоматического повтора не будет."
                : "Отправка недоступна. Проверь чат, подключение и права.",
            },
            !committed &&
              !["CODEX_REQUEST_TIMEOUT", "CODEX_UNAVAILABLE", "PREPARATION_FAILED"].includes(
                code ?? "",
              ),
          );
        }
      }
    }
    // Bound terminal history; uncertain receipts remain available for reconciliation.
    this.db
      .prepare(
        "DELETE FROM codex_schedule_runs WHERE dueAt<? AND json_extract(value,'$.state') IN ('sent','failed','cancelled') AND id NOT IN (SELECT json_extract(value,'$.last.id') FROM codex_schedules WHERE json_extract(value,'$.last.id') IS NOT NULL)",
      )
      .run(this.now() - 90 * 86400000);
    this.db.exec(
      "DELETE FROM codex_schedule_receipts WHERE id NOT IN (SELECT id FROM codex_schedule_runs)",
    );
  }
}

/** Called only for an actual native user item, never an optimistic local message. */
export function observeScheduleReceipt(
  db: DatabaseSync,
  id: string,
  nativeId: string,
  turnId: string,
) {
  if (
    !id ||
    !turnId ||
    !db.prepare("SELECT 1 FROM sqlite_master WHERE name='codex_schedule_runs'").get()
  )
    return;
  const row = db.prepare("SELECT value FROM codex_schedule_runs WHERE id=?").get(id);
  if (row && JSON.parse(String(row.value)).nativeId === nativeId)
    db.prepare("INSERT OR IGNORE INTO codex_schedule_receipts VALUES(?,?,?)").run(
      id,
      nativeId,
      turnId,
    );
}
