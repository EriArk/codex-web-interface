import { createHash, randomUUID } from "node:crypto";
import { deliveryMessage, runProjectDelivery } from "@codex-web/machines";
import {
  type DeliveryInput,
  type DeliveryMachineReceipt,
  type DeliveryObservation,
  type DeliveryOperation,
  type DeliveryState,
  deliveryInputSchema,
  HubError,
} from "@codex-web/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Sessions } from "./sessions.js";

export function registerProjectDelivery(
  app: FastifyInstance,
  sessions: Sessions,
  probe = runProjectDelivery,
  policy: (projectId: string, receipt: DeliveryMachineReceipt) => void = () => {},
) {
  const db = sessions.store.db,
    running = new Map<string, Promise<void>>(),
    preparing = new Map<string, Promise<DeliveryOperation>>(),
    readers = new Map<string, Promise<DeliveryObservation>>();
  const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
  const context = (id: string) => {
    const project = sessions.project(id);
    if (project.unassigned || sessions.catalog.library.get("project", id)?.deleted)
      throw new HubError(404, "PROJECT_REQUIRED", "Выбери существующий проект.");
    const machine = sessions.catalog.machine(project.machineId);
    return { project, machine, binding: hash([project.id, project.workingDirectory, machine]) };
  };
  const keys = (p: unknown) =>
    z.object({ id: z.string().min(1).max(100), operation: z.string().uuid().optional() }).parse(p);
  const get = (id: string, projectId: string): DeliveryOperation => {
    const row = db
      .prepare("SELECT value FROM delivery_operations WHERE id=? AND projectId=?")
      .get(id, projectId);
    if (!row) throw new HubError(404, "DELIVERY_MISSING", "Операция не найдена.");
    return JSON.parse(String(row.value));
  };
  const put = (v: DeliveryOperation, binding?: string) => {
    v.updatedAt = Date.now();
    db.prepare(
      "INSERT INTO delivery_operations VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,value=excluded.value,updatedAt=excluded.updatedAt",
    ).run(
      v.id,
      v.projectId,
      v.machineId,
      v.state,
      JSON.stringify(v),
      binding ?? "",
      v.createdAt,
      v.updatedAt,
    );
    return v;
  };
  for (const row of db.prepare("SELECT value FROM delivery_operations WHERE state='running'").all())
    put({
      ...JSON.parse(String(row.value)),
      state: "unknown",
      error: deliveryMessage("DELIVERY_UNKNOWN"),
    });
  const bound = (op: DeliveryOperation) => {
    const c = context(op.projectId),
      row = db.prepare("SELECT binding FROM delivery_operations WHERE id=?").get(op.id);
    if (row?.binding !== c.binding)
      throw new HubError(
        409,
        "DELIVERY_PROJECT_CHANGED",
        "Папка или компьютер проекта изменились. Операция сохранена для прежнего проекта.",
      );
    return c;
  };
  const checked = (op: DeliveryOperation, result: unknown): DeliveryOperation => {
    const r = result as DeliveryMachineReceipt | null;
    if (
      !r ||
      r.id !== op.id ||
      r.fingerprint !== op.fingerprint ||
      hash(r.input) !== hash(op.input) ||
      !["prepared", "running", "completed", "failed", "unknown"].includes(r.state)
    )
      throw new HubError(503, "DELIVERY_UNAVAILABLE", deliveryMessage("DELIVERY_UNAVAILABLE"));
    return put({ ...op, ...r, error: r.code ? deliveryMessage(r.code) : undefined });
  };
  const reconcile = async (op: DeliveryOperation) => {
    if (!["unknown", "running"].includes(op.state) || running.has(op.id)) return op;
    const c = bound(op);
    try {
      const r = await probe(c.machine, c.project.workingDirectory, { op: "status", id: op.id });
      if (r) return checked(op, r);
    } catch {}
    return get(op.id, op.projectId);
  };
  app.get("/api/projects/:id/delivery", async (req) => {
    const { id } = keys(req.params),
      c = context(id);
    if (readers.has(id)) return readers.get(id)!;
    if (readers.size >= 2)
      throw new HubError(429, "DELIVERY_BUSY", deliveryMessage("DELIVERY_BUSY"));
    const read = (async () => {
      const state = (await probe(c.machine, c.project.workingDirectory, {
        op: "inspect",
      })) as DeliveryState;
      if (!state || !Array.isArray(state.paths) || typeof state.fingerprint !== "string")
        throw new HubError(503, "DELIVERY_UNAVAILABLE", deliveryMessage("DELIVERY_UNAVAILABLE"));
      if (context(id).binding !== c.binding)
        throw new HubError(409, "DELIVERY_PROJECT_CHANGED", "Проект изменился. Обнови состояние.");
      const v: DeliveryObservation = {
        id: randomUUID(),
        projectId: id,
        projectName: c.project.name,
        state,
        createdAt: Date.now(),
      };
      db.prepare("INSERT INTO delivery_observations VALUES(?,?,?,?)").run(
        v.id,
        id,
        JSON.stringify(v),
        v.createdAt,
      );
      // Only recent read observations are transient. Actions embed their exact immutable evidence.
      db.prepare(
        "DELETE FROM delivery_observations WHERE projectId=? AND id NOT IN (SELECT id FROM delivery_observations WHERE projectId=? ORDER BY createdAt DESC,id DESC LIMIT 20)",
      ).run(id, id);
      return v;
    })();
    readers.set(id, read);
    try {
      return await read;
    } finally {
      readers.delete(id);
    }
  });
  app.get("/api/projects/:id/delivery/operations", (req) => {
    const { id } = keys(req.params);
    context(id);
    return {
      items: db
        .prepare(
          "SELECT value FROM delivery_operations WHERE projectId=? ORDER BY createdAt DESC,id DESC LIMIT 20",
        )
        .all(id)
        .map((r) => JSON.parse(String(r.value))),
    };
  });
  app.put("/api/projects/:id/delivery/:operation", async (req) => {
    const { id, operation } = keys(req.params),
      key = z.string().uuid().parse(operation),
      input = deliveryInputSchema.parse(req.body),
      c = context(id);
    const previous = db.prepare("SELECT projectId FROM delivery_operations WHERE id=?").get(key);
    const same = (v: DeliveryOperation) => {
      if (v.projectId !== id || hash(v.input) !== hash(input))
        throw new HubError(409, "DELIVERY_KEY_REUSED", deliveryMessage("DELIVERY_KEY_REUSED"));
      return v;
    };
    if (previous) return same(get(key, String(previous.projectId)));
    if (preparing.has(key)) return same(await preparing.get(key)!);
    if (preparing.size >= 2)
      throw new HubError(429, "DELIVERY_BUSY", deliveryMessage("DELIVERY_BUSY"));
    if (input.reviewId) {
      const r = db.prepare("SELECT scopeKey FROM work_reviews WHERE id=?").get(input.reviewId);
      if (r?.scopeKey !== "codex:" + id)
        throw new HubError(409, "REVIEW_CONFLICT", "Приёмка относится к другому проекту.");
    }
    if (Number(db.prepare("SELECT count(*) n FROM delivery_operations").get()?.n) >= 10000)
      throw new HubError(409, "DELIVERY_LIMIT", "Хранилище Git-операций заполнено.");
    const job = (async () => {
      const r = (await probe(c.machine, c.project.workingDirectory, {
        op: "prepare",
        id: key,
        input,
      })) as DeliveryMachineReceipt;
      if (!r || r.id !== key || hash(r.input) !== hash(input) || !r.fingerprint)
        throw new HubError(503, "DELIVERY_UNAVAILABLE", deliveryMessage("DELIVERY_UNAVAILABLE"));
      policy(id, r);
      return put(
        { ...r, projectId: id, projectName: c.project.name, machineId: c.machine.id },
        c.binding,
      );
    })();
    preparing.set(key, job);
    try {
      return await job;
    } finally {
      preparing.delete(key);
    }
  });
  app.get("/api/projects/:id/delivery/:operation", async (req) => {
    const { id, operation } = keys(req.params);
    return reconcile(get(operation!, id));
  });
  app.post("/api/projects/:id/delivery/:operation/execute", async (req, reply) => {
    const { id, operation } = keys(req.params),
      op = get(operation!, id);
    const b = z
      .object({ confirm: z.literal(true), fingerprint: z.string().length(64) })
      .strict()
      .parse(req.body);
    if (b.fingerprint !== op.fingerprint)
      throw new HubError(409, "DELIVERY_CHANGED", deliveryMessage("DELIVERY_CHANGED"));
    if (running.has(op.id) || op.state === "completed") return op;
    if (op.state !== "prepared") return reconcile(op);
    const c = bound(op);
    if (
      db
        .prepare(
          "SELECT 1 FROM delivery_operations WHERE machineId=? AND state IN ('running','unknown') AND id<>? LIMIT 1",
        )
        .get(op.machineId, op.id)
    )
      throw new HubError(409, "DELIVERY_BUSY", deliveryMessage("DELIVERY_BUSY"));
    await sessions.externalActivity.refresh();
    policy(id, op);
    const release = sessions.beginProjectDelivery(id);
    put({ ...op, state: "running", error: undefined });
    const job = (async () => {
      try {
        checked(
          op,
          await probe(c.machine, c.project.workingDirectory, {
            op: "apply",
            id: op.id,
            fingerprint: op.fingerprint,
          }),
        );
      } catch {
        put({ ...op, state: "unknown", error: deliveryMessage("DELIVERY_UNKNOWN") });
      } finally {
        release();
      }
    })();
    running.set(op.id, job);
    void job.finally(() => running.delete(op.id));
    return reply.code(202).send(get(op.id, id));
  });
  app.addHook("preClose", async () => {
    await Promise.allSettled([...running.values(), ...preparing.values(), ...readers.values()]);
  });
}
