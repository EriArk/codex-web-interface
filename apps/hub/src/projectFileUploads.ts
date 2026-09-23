import { AsyncLocalStorage } from "node:async_hooks";
import { dirname, join } from "node:path";
import { authorizeMachine, runFileTools, stageAttachment } from "@codex-web/machines";
import { HubError, UPLOAD_CHUNK_BYTES } from "@codex-web/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { ChunkUploads } from "./chunk-uploads.js";
import type { Sessions } from "./sessions.js";

export function registerProjectFileUploads(
  app: FastifyInstance,
  sessions: Sessions,
  access: (req: FastifyRequest, capability: string) => { checkout: string; projectId: string },
) {
  const requests = new AsyncLocalStorage<FastifyRequest>();
  const request = () => requests.getStore()!;
  const authorize = () =>
    access(request(), z.string().uuid().parse(request().headers["x-file-capability"]));
  const receiptRoot = join(
    sessions.config.hub.databasePath === ":memory:"
      ? sessions.config.hub.resultsPath
      : dirname(sessions.config.hub.databasePath),
    "file-operations",
  );
  const uploads = new ChunkUploads(
    join(sessions.config.hub.resultsPath, "project-upload-transfers"),
    sessions.store,
    () => ({ limit: sessions.config.hub.storage.attachmentBytes, used: 0 }),
    (spec) => {
      const bound = authorize();
      if (bound.projectId !== spec.projectId || bound.checkout !== spec.checkout)
        throw new HubError(
          409,
          "FILE_SCOPE_CHANGED",
          "Рабочая копия изменилась. Открой файлы проекта заново.",
        );
    },
    async (id, spec, source, sha256) => {
      authorize();
      const project = sessions.project(spec.projectId!),
        machine = sessions.catalog.machine(project.machineId);
      sessions.assertWritable(project.id);
      const release = sessions.beginProjectDelivery(project.id);
      try {
        const deadline =
          Date.now() + Math.max(40000, Math.min(1800000, (spec.bytes / 262144) * 1000));
        const staged = await stageAttachment(machine, project.id, id, spec.name, source, deadline);
        authorize();
        const value = await runFileTools(
          machine,
          project.workingDirectory,
          {
            op: "import",
            path: spec.target!,
            id,
            ...(spec.replace ? { fingerprint: spec.replace } : {}),
          },
          receiptRoot,
          { path: staged, bytes: spec.bytes, sha256 },
        );
        authorize();
        return { ...value, checkout: spec.checkout };
      } finally {
        release();
      }
    },
    true,
  );
  const route = "/api/projects/:id/file-uploads/:uploadId";
  const id = (req: FastifyRequest) =>
    z.object({ uploadId: z.string().uuid() }).parse(req.params).uploadId;
  const within = <T>(req: FastifyRequest, fn: () => T) =>
    requests.run(req, () => {
      authorize();
      return fn();
    });
  app.post(route, (req) =>
    within(req, async () => {
      const bound = authorize();
      const body = z
        .object({
          name: z.string().min(1).max(240),
          bytes: z.number().int().nonnegative(),
          folder: z.string().max(1800),
          checkout: z.string(),
          replace: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .optional(),
        })
        .strict()
        .parse(req.body);
      if (body.checkout !== bound.checkout)
        throw new HubError(409, "FILE_SCOPE_CHANGED", "Рабочая копия изменилась.");
      if (/[\\/]/.test(body.name))
        throw new HubError(400, "FILE_PATH", "Укажи имя файла без пути.");
      const target = body.folder ? body.folder + "/" + body.name : body.name;
      const spec = {
        kind: "project",
        projectId: bound.projectId,
        checkout: body.checkout,
        target,
        name: body.name,
        bytes: body.bytes,
        ...(body.replace ? { replace: body.replace } : {}),
      };
      // Exact repeated begins return their receipt, including after the destination now exists.
      try {
        uploads.state(id(req));
        return uploads.begin(id(req), spec);
      } catch (e) {
        if (!(e instanceof HubError) || e.code !== "UPLOAD_MISSING") throw e;
      }
      const project = sessions.project(bound.projectId),
        machine = sessions.catalog.machine(project.machineId);
      sessions.assertWritable(project.id);
      const release = sessions.beginProjectDelivery(project.id);
      try {
        await runFileTools(
          machine,
          project.workingDirectory,
          { op: "import-check", path: target, fingerprint: body.replace },
          receiptRoot,
        );
        authorizeMachine(machine);
        authorize();
        return await uploads.begin(id(req), spec);
      } finally {
        release();
      }
    }),
  );
  app.get(route, (req) => within(req, () => uploads.state(id(req))));
  app.put(
    route,
    {
      bodyLimit: UPLOAD_CHUNK_BYTES,
      config: {
        rateLimit: {
          max: 600,
          timeWindow: "1 minute",
          keyGenerator: (req: { ip: string }) => `${req.ip}:project-upload-chunks`,
        },
      },
    },
    (req) =>
      within(req, () =>
        uploads.append(
          id(req),
          z.object({ offset: z.coerce.number().int().nonnegative() }).strict().parse(req.query)
            .offset,
          req.body as Buffer,
        ),
      ),
  );
  app.post(route + "/complete", (req) => within(req, () => uploads.complete(id(req))));
  app.delete(route, (req) => within(req, () => uploads.cancel(id(req))));
}
