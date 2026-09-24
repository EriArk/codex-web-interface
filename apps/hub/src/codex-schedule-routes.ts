import { createHash } from "node:crypto";
import {
  type ConversationBindingSpec,
  codexScheduleInputSchema,
  HubError,
} from "@codex-web/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { CodexSchedules, type ScheduleTarget, scheduleConflict } from "./codex-schedules.js";
import type { ProjectIntake } from "./intake.js";
import type { QueueService } from "./queue.js";
import { nextScheduleTime } from "./schedule-time.js";

export function registerCodexSchedules(
  app: FastifyInstance,
  intake: ProjectIntake,
  queue: QueueService,
  authority: (id: string) => unknown = () => null,
) {
  const { sessions, bindings, work } = intake,
    db = sessions.store.db;
  const scope = (id: string) => ({
    client: "codex" as const,
    projectId: id,
    name: sessions.project(id).name,
  });
  const spec = (id: string, role: "work" | "intake"): ConversationBindingSpec => {
    const p = sessions.project(id);
    work.context.assertProject(scope(id));
    return {
      provider: "codex",
      scope: "project",
      scopeId: id,
      role,
      lifecycle: role === "work" ? "rotating" : "persistent",
      visibility: role === "work" ? "normal" : "utility",
      execution: { machineId: p.machineId, workingDirectory: p.workingDirectory },
    };
  };
  const stamp = (id: string, role: "work" | "intake") => {
    sessions.authorizeExecution();
    const s = spec(id, role);
    return createHash("sha256")
      .update(JSON.stringify([s, sessions.catalog.machine(s.execution!.machineId), authority(id)]))
      .digest("hex");
  };
  const target = (id: string, role: "work" | "intake", opened: string): ScheduleTarget => {
    const b = bindings.ensure(spec(id, role));
    const t = sessions.thread(opened);
    if (t.projectId !== id || !!t.diagnostic !== (role === "intake") || t.archived)
      throw scheduleConflict();
    const current = role === "intake" ? intake.get(id) : work.context.current(scope(id));
    if (
      role === "intake"
        ? current.threadId !== opened
        : "explicit" in current && current.explicit && current.threadId !== opened
    )
      throw new HubError(
        409,
        "SCHEDULE_CURRENT_REQUIRED",
        "Расписание рабочего проекта открывается из его текущего чата.",
      );
    return {
      key: b.id,
      name: sessions.project(id).name,
      role,
      revision: current.revision,
      projectId: id,
      stamp: stamp(id, role),
      sourceThreadId: opened,
      ...(role === "intake" ? { nativeId: t.codexThreadId } : {}),
    };
  };
  const resolve = (t: ScheduleTarget) => {
    if (
      stamp(t.projectId, t.role) !== t.stamp ||
      bindings.get(spec(t.projectId, t.role))?.id !== t.key
    )
      throw scheduleConflict();
    const current =
      t.role === "intake" ? intake.get(t.projectId) : work.context.current(scope(t.projectId));
    if (
      !current.threadId ||
      current.status === "missing" ||
      ("explicit" in current && !current.explicit)
    )
      throw scheduleConflict();
    const thread = sessions.thread(current.threadId);
    if (
      t.role === "intake" &&
      (current.revision !== t.revision || thread.codexThreadId !== t.nativeId)
    )
      throw scheduleConflict();
    if (thread.archived || sessions.catalog.library.get("thread", thread.codexThreadId)?.deleted)
      throw scheduleConflict();
    return { threadId: thread.id, nativeId: thread.codexThreadId, revision: current.revision };
  };
  const scheduler = new CodexSchedules(db, {
    resolve,
    async send(t, run, text, commit) {
      let destination = resolve(t);
      sessions.assertWritable(t.projectId);
      const busy = () => {
        throw new HubError(409, "SCHEDULE_BUSY", "Ожидает свободного чата.");
      };
      if (
        ["starting", "running", "waiting_approval", "unknown"].includes(
          sessions.thread(destination.threadId).status,
        )
      )
        return busy();
      const check = () => {
        const actual = resolve(t);
        if (actual.threadId !== destination.threadId || actual.revision !== destination.revision)
          return busy();
        destination = actual;
        commit(actual);
      };
      const send = async () => {
        if (t.role === "intake") {
          await intake.send(
            t.projectId,
            run.id,
            { text, sources: [], revision: t.revision },
            check,
          );
          const c = db
            .prepare("SELECT state,response FROM commands WHERE scope=? AND key=?")
            .get("intake-turn:" + t.key, run.id);
          const result = c?.state === "complete" ? JSON.parse(String(c.response)) : null;
          if (!result?.turnId) throw new Error("Native receipt missing");
          return result as { turnId: string };
        }
        return (await sessions.startTurn(destination.threadId, text, undefined, [], run.id, false, {
          beforeCommit: check,
        })) as { turnId: string };
      };
      return t.role === "work"
        ? queue.whenEmpty(destination.threadId, send)
        : sessions.withThreadWrite(destination.threadId, send);
    },
    async reconcile(t, run) {
      if (stamp(t.projectId, t.role) !== t.stamp || !run.threadId) return;
      const thread = sessions.thread(run.threadId);
      if (
        thread.projectId !== t.projectId ||
        thread.codexThreadId !== run.nativeId ||
        thread.archived
      )
        return;
      await sessions.catalog.history(thread);
    },
  });
  const params = z.object({
    projectId: z.string().min(1).max(100),
    role: z.enum(["work", "intake"]),
    threadId: z.string().min(1).max(100),
  });
  const root = "/api/projects/:projectId/schedules/:role/:threadId";
  app.get(root, (req) => {
    const p = params.parse(req.params);
    return scheduler.list(target(p.projectId, p.role, p.threadId));
  });
  app.post(root, (req) => {
    const p = params.parse(req.params),
      body = codexScheduleInputSchema
        .extend({ targetRevision: z.number().int().nonnegative() })
        .parse(req.body);
    const t = target(p.projectId, p.role, p.threadId);
    const key = z.string().uuid().parse(req.headers["idempotency-key"]);
    if (
      body.targetRevision !== t.revision &&
      !db.prepare("SELECT 1 FROM codex_schedules WHERE id=?").get(key)
    )
      throw scheduleConflict();
    if (
      !nextScheduleTime(body.rule, Date.now()) &&
      !db.prepare("SELECT 1 FROM codex_schedules WHERE id=?").get(key)
    )
      throw new HubError(400, "SCHEDULE_PAST", "Выбери время в будущем.");
    if (p.role === "work" && !work.context.current(scope(p.projectId)).explicit)
      work.context.adopt(scope(p.projectId), p.threadId);
    const { targetRevision: _revision, ...input } = body;
    return scheduler.create(key, target(p.projectId, p.role, p.threadId), input);
  });
  app.patch(root + "/:id", (req) => {
    const p = params.extend({ id: z.string().uuid() }).parse(req.params);
    const body = z
      .object({
        revision: z.number().int().positive(),
        action: z.enum(["edit", "pause", "resume", "cancel"]),
        input: codexScheduleInputSchema.optional(),
      })
      .strict()
      .parse(req.body);
    return scheduler.change(
      p.id,
      target(p.projectId, p.role, p.threadId),
      body.revision,
      body.action,
      body.input,
    );
  });
  app.addHook("onReady", async () => scheduler.start());
  return scheduler;
}
