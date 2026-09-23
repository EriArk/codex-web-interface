import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { authorizeMachine, runFileTools, verifyProjectRoot } from "@codex-web/machines";
import { editableFile, HubError } from "@codex-web/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Sessions } from "./sessions.js";

export function registerFileTools(app: FastifyInstance, sessions: Sessions) {
  // Local Linux receipts must survive engine replacement in the personal runtime volume.
  const receiptRoot = join(
    sessions.config.hub.databasePath === ":memory:"
      ? sessions.config.hub.resultsPath
      : dirname(sessions.config.hub.databasePath),
    "file-operations",
  );
  const grants = new Map<string, { scope: string; expires: number }>();
  const scope = (req: FastifyRequest) => {
    const c = context(req);
    return createHash("sha256")
      .update(
        JSON.stringify([
          req.headers.cookie,
          c.project.id,
          c.project.workingDirectory,
          c.machine.id,
        ]),
      )
      .digest("hex");
  };
  const context = (req: FastifyRequest) => {
    const { id } = z.object({ id: z.string().min(1).max(100) }).parse(req.params);
    const project = sessions.project(id);
    if (project.unassigned) throw new HubError(400, "PROJECT_REQUIRED", "Сначала выбери проект.");
    return { project, machine: sessions.catalog.machine(project.machineId) };
  };
  const path = z.string().min(1).max(2048);
  const checkout = (req: FastifyRequest) => {
    const c = context(req);
    return createHash("sha256")
      .update(JSON.stringify([c.project.id, c.machine.id, c.project.workingDirectory]))
      .digest("hex");
  };
  const current = (req: FastifyRequest, expected: string) => {
    authorizeMachine(context(req).machine);
    if (checkout(req) !== expected)
      throw new HubError(
        409,
        "FILE_SCOPE_CHANGED",
        "Рабочая копия изменилась. Открой файлы проекта заново.",
      );
  };
  app.post("/api/projects/:id/file-tools/access", async (req) => {
    const c = context(req);
    const body = z
      .object({ unlock: z.boolean(), capability: z.string().uuid().optional() })
      .strict()
      .parse(req.body);
    for (const [key, value] of grants) if (value.expires < Date.now()) grants.delete(key);
    if (!body.unlock) {
      if (body.capability && grants.get(body.capability)?.scope === scope(req))
        grants.delete(body.capability);
      return { capability: "" };
    }
    sessions.assertWritable(c.project.id);
    const expected = checkout(req);
    const release = sessions.beginProjectDelivery(c.project.id);
    try {
      await verifyProjectRoot(c.machine, c.project.workingDirectory);
      current(req, expected);
      if (c.machine.type !== "local-linux" && !c.machine.codex.activityNode)
        throw new HubError(
          409,
          "FILE_UNAVAILABLE",
          "На компьютере не настроены файловые операции.",
        );
      while (grants.size >= 128) grants.delete(grants.keys().next().value!);
      const capability = randomUUID();
      grants.set(capability, { scope: scope(req), expires: Date.now() + 30 * 60 * 1000 });
      return { capability, checkout: checkout(req) };
    } finally {
      release();
    }
  });
  app.get("/api/projects/:id/file-tools", async (req) => {
    const c = context(req);
    const expected = checkout(req);
    const q = z
      .object({ path, op: z.enum(["read", "stat"]) })
      .strict()
      .parse(req.query);
    if (q.op === "read" && !editableFile(q.path))
      throw new HubError(400, "FILE_FORMAT", "Для этого формата доступен просмотр или скачивание.");
    const value = await runFileTools(c.machine, c.project.workingDirectory, q, receiptRoot);
    current(req, expected);
    return { ...value, checkout: expected };
  });
  app.post("/api/projects/:id/file-tools", { bodyLimit: 13 * 1024 * 1024 }, async (req) => {
    const c = context(req);
    const expected = checkout(req);
    const b = z
      .object({
        op: z.enum(["save", "create", "mkdir", "copy", "move", "delete"]),
        path,
        target: path.optional(),
        fingerprint: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
        text: z
          .string()
          .max(2 * 1024 * 1024)
          .optional(),
        bom: z.boolean().optional(),
        id: z.string().uuid(),
        capability: z.string().uuid(),
      })
      .strict()
      .parse(req.body);
    const grant = grants.get(b.capability);
    if (!grant || grant.expires < Date.now() || grant.scope !== scope(req))
      throw new HubError(403, "FILE_LOCKED", "Разблокируй файлы для этой рабочей копии.");
    if ((b.op === "save" || b.op === "create") && !editableFile(b.path))
      throw new HubError(400, "FILE_FORMAT", "Выбери текстовый файл с поддерживаемым расширением.");
    sessions.assertWritable(c.project.id);
    const release = sessions.beginProjectDelivery(c.project.id);
    try {
      const { capability: _, ...operation } = b;
      const value = await runFileTools(
        c.machine,
        c.project.workingDirectory,
        operation,
        receiptRoot,
      );
      current(req, expected);
      return { ...value, checkout: expected };
    } finally {
      release();
    }
  });
}
