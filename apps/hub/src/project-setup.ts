import { createHash } from "node:crypto";
import { posix, win32 } from "node:path";
import { runProjectSetup, setupMessage } from "@codex-web/machines";
import {
  HubError,
  type ProjectSetupInput,
  type ProjectSetupOperation,
  type SetupInspection,
  type SetupMachineReceipt,
} from "@codex-web/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Sessions } from "./sessions.js";

const inputSchema = z
  .object({
    machineId: z.string().min(1).max(100),
    name: z.string().trim().min(1).max(120),
    workingDirectory: z.string().min(1).max(2048),
    createDirectory: z.boolean(),
    repository: z
      .object({
        mode: z.enum(["none", "create", "connect"]),
        owner: z.string().max(100),
        name: z.string().max(100),
        visibility: z.enum(["private", "public"]),
        description: z.string().max(350),
      })
      .strict(),
  })
  .strict();
export function registerProjectSetup(
  app: FastifyInstance,
  sessions: Sessions,
  probe = runProjectSetup,
) {
  const db = sessions.store.db,
    running = new Map<string, Promise<void>>(),
    preparing = new Map<string, Promise<ProjectSetupOperation>>();
  const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
  const get = (id: string): ProjectSetupOperation => {
    const row = db.prepare("SELECT value FROM project_setup_operations WHERE id=?").get(id);
    if (!row) throw new HubError(404, "SETUP_NOT_FOUND", "Операция настройки не найдена.");
    return JSON.parse(String(row.value));
  };
  const put = (value: ProjectSetupOperation) => {
    value.updatedAt = Date.now();
    db.prepare(
      "INSERT INTO project_setup_operations(id,machineId,state,value,createdAt,updatedAt) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,value=excluded.value,updatedAt=excluded.updatedAt",
    ).run(
      value.id,
      value.input.machineId,
      value.state,
      JSON.stringify(value),
      value.createdAt,
      value.updatedAt,
    );
    return value;
  };
  for (const row of db
    .prepare("SELECT value FROM project_setup_operations WHERE state='running'")
    .all())
    put({
      ...JSON.parse(String(row.value)),
      state: "unknown",
      error: "Настройка прервалась на Hub. Проверь её состояние перед продолжением.",
    });
  const identifier = (params: unknown) => z.object({ id: z.string().uuid() }).parse(params).id;
  const register = async (op: ProjectSetupOperation) => {
    const machine = sessions.catalog.machine(op.input.machineId),
      path = machine.type === "ssh-windows" ? win32 : posix;
    const canonical = (value: string) =>
      machine.type === "ssh-windows" ? path.resolve(value).toLowerCase() : path.resolve(value);
    await sessions.catalog.refresh(true);
    const existing = sessions.catalog
      .publicProjects()
      .find(
        (p) =>
          p.machineId === machine.id &&
          !p.unassigned &&
          canonical(p.workingDirectory) === canonical(op.input.workingDirectory),
      );
    if (existing) return existing;
    // The same native idempotency key is retained even if the acknowledgement is lost.
    return sessions.catalog.createProject(
      machine.id,
      op.input.name,
      op.input.workingDirectory,
      false,
      op.id,
    );
  };
  const execute = async (id: string) => {
    const op = get(id),
      machine = sessions.catalog.machine(op.input.machineId);
    op.state = "running";
    delete op.error;
    put(op);
    try {
      const result = (await probe(machine, {
        op: "apply",
        id,
        input: op.input,
        fingerprint: op.inspection.fingerprint,
      })) as SetupMachineReceipt;
      if (!result || result.id !== id)
        throw new HubError(503, "SETUP_UNAVAILABLE", setupMessage("SETUP_UNAVAILABLE"));
      op.phase = result.phase;
      if (result.state !== "complete") {
        op.state = "unknown";
        op.error = setupMessage(result.error ?? "SETUP_UNAVAILABLE");
        put(op);
        return;
      }
      op.phase = "register-project";
      put(op);
      const project = await register(op);
      if (!project) throw Error("PROJECT_CREATE_UNCONFIRMED");
      op.project = project;
      op.state = "complete";
      op.phase = "complete";
      delete op.error;
      put(op);
    } catch (e) {
      const known =
        e instanceof HubError &&
        [
          "SETUP_CHANGED",
          "REMOTE_CONFLICT",
          "DIRECTORY_NOT_EMPTY",
          "PARENT_REPOSITORY",
          "REPOSITORY_EXISTS",
          "INVALID_PATH",
          "UNRELATED_REPOSITORY",
        ].includes(e.code);
      op.state = known ? "failed" : "unknown";
      op.error =
        e instanceof HubError
          ? e.message
          : "Компьютер не подтвердил завершение. Подготовленные файлы и операция сохранены.";
      put(op);
    }
  };
  app.get("/api/project-setup", async () => ({
    operations: db
      .prepare(
        "SELECT value FROM project_setup_operations WHERE state!='complete' ORDER BY updatedAt DESC LIMIT 20",
      )
      .all()
      .map((row) => JSON.parse(String(row.value))),
  }));
  app.get("/api/machines/:id/github-repositories", async (req) => {
    const { id } = z.object({ id: z.string().min(1).max(100) }).parse(req.params),
      q = z
        .object({
          search: z.string().max(120).default(""),
          page: z.coerce.number().int().min(1).max(100).default(1),
        })
        .strict()
        .parse(req.query);
    return probe(sessions.catalog.machine(id), { op: "repositories", ...q });
  });
  app.post("/api/project-setup/prepare", async (req) => {
    const id = z.string().uuid().parse(req.headers["idempotency-key"]),
      input = inputSchema.parse(req.body);
    sessions.catalog.machine(input.machineId);
    const previous = db.prepare("SELECT value FROM project_setup_operations WHERE id=?").get(id);
    if (previous) {
      const value = JSON.parse(String(previous.value));
      if (hash(value.input) !== hash(input))
        throw new HubError(409, "OPERATION_CONFLICT", setupMessage("OPERATION_CONFLICT"));
      return value;
    }
    if (preparing.has(id)) {
      const value = await preparing.get(id)!;
      if (hash(value.input) !== hash(input))
        throw new HubError(409, "OPERATION_CONFLICT", setupMessage("OPERATION_CONFLICT"));
      return value;
    }
    if (preparing.size >= 2) throw new HubError(429, "SETUP_BUSY", setupMessage("SETUP_BUSY"));
    const job = (async () => {
      const inspection = (await probe(sessions.catalog.machine(input.machineId), {
        op: "inspect",
        input,
      })) as SetupInspection;
      if (!inspection?.fingerprint || !Array.isArray(inspection.steps))
        throw new HubError(503, "SETUP_UNAVAILABLE", setupMessage("SETUP_UNAVAILABLE"));
      return put({
        id,
        input,
        inspection,
        state: "prepared",
        phase: "review",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    })();
    preparing.set(id, job);
    try {
      return await job;
    } finally {
      preparing.delete(id);
    }
  });
  app.get("/api/project-setup/:id", async (req) => {
    const id = identifier(req.params),
      op = get(id);
    if (op.state === "unknown" || op.state === "running") {
      try {
        const status = (await probe(sessions.catalog.machine(op.input.machineId), {
          op: "status",
          id,
        })) as SetupMachineReceipt | null;
        const fresh = get(id);
        if (status && (fresh.state === "unknown" || fresh.state === "running")) {
          fresh.phase = status.phase;
          if (fresh.state === "unknown")
            fresh.error =
              status.state === "complete"
                ? "Файлы готовы. Продолжи, чтобы подключить проект."
                : setupMessage(status.error ?? "SETUP_UNAVAILABLE");
          put(fresh);
        }
      } catch {}
    }
    return get(id);
  });
  app.post("/api/project-setup/:id/execute", async (req, reply) => {
    const id = identifier(req.params),
      op = get(id);
    z.object({})
      .strict()
      .parse(req.body ?? {});
    if (op.state === "complete" || running.has(id)) return op;
    const conflict = db
      .prepare(
        "SELECT id FROM project_setup_operations WHERE machineId=? AND state='running' AND id!=?",
      )
      .get(op.input.machineId, id);
    if (conflict) throw new HubError(409, "SETUP_BUSY", setupMessage("SETUP_BUSY"));
    if (op.state === "failed")
      throw new HubError(409, "SETUP_CHANGED", setupMessage("SETUP_CHANGED"));
    const work = execute(id);
    running.set(id, work);
    void work.finally(() => running.delete(id));
    return reply.code(202).send(get(id));
  });
  app.addHook("onClose", async () => {
    await Promise.allSettled([...running.values(), ...preparing.values()]);
  });
}
