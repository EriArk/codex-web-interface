import { createReadStream, mkdirSync } from "node:fs";
import { rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runFileTools } from "@codex-web/machines";
import { HubError, type MachineConfig, type ProjectConfig } from "@codex-web/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { zipSync } from "fflate";
import { z } from "zod";
import type { Sessions } from "./sessions.js";

let building = 0;
export function registerProjectArchives(
  app: FastifyInstance,
  sessions: Sessions,
  access: (req: FastifyRequest) => {
    project: ProjectConfig;
    machine: MachineConfig;
    checkout: string;
  },
) {
  const root = join(sessions.config.hub.resultsPath, "project-archives"),
    db = sessions.store.db;
  mkdirSync(root, { recursive: true, mode: 0o700 });
  db.exec(
    "CREATE TABLE IF NOT EXISTS project_file_archives(id TEXT PRIMARY KEY,spec TEXT NOT NULL,state TEXT NOT NULL,bytes INTEGER NOT NULL DEFAULT 0,updatedAt INTEGER NOT NULL)",
  );
  const running = new Map<string, Promise<unknown>>();
  const missing = () =>
    new HubError(404, "ARCHIVE_MISSING", "Архив не найден или срок хранения истёк.");
  const idOf = (req: FastifyRequest) =>
    z.object({ archiveId: z.string().uuid() }).parse(req.params).archiveId;
  const file = (id: string) => join(root, id + ".zip");
  const read = (req: FastifyRequest) => {
    const bound = access(req),
      id = idOf(req),
      row = db.prepare("SELECT * FROM project_file_archives WHERE id=?").get(id);
    if (!row || Number(row.updatedAt) < Date.now() - 1800000) throw missing();
    const spec = JSON.parse(String(row.spec)) as {
      projectId: string;
      checkout: string;
      paths: string[];
    };
    if (bound.project.id !== spec.projectId || bound.checkout !== spec.checkout) throw missing();
    return { ...bound, id, row, spec };
  };
  const state = (req: FastifyRequest) => {
    const { id, project, row } = read(req);
    return {
      state: row.state,
      bytes: Number(row.bytes),
      ...(row.state === "ready"
        ? {
            url: `/api/projects/${encodeURIComponent(project.id)}/file-archives/${id}/content`,
            name: project.name.replace(/[\\/:*?"<>|\r\n]/g, "_").slice(0, 100) + ".zip",
          }
        : {}),
    };
  };
  const route = "/api/projects/:id/file-archives/:archiveId";
  app.get(route, (req) => state(req));
  app.delete(route, async (req) => {
    const { id } = read(req);
    db.prepare("UPDATE project_file_archives SET state='cancelled',updatedAt=? WHERE id=?").run(
      Date.now(),
      id,
    );
    await unlink(file(id)).catch(() => {});
    return state(req);
  });
  app.post(route, { bodyLimit: 256 * 1024 }, async (req) => {
    const bound = access(req),
      id = idOf(req),
      body = z
        .object({
          checkout: z.string(),
          paths: z.array(z.string().min(1).max(2048)).min(1).max(100),
        })
        .strict()
        .parse(req.body);
    if (body.checkout !== bound.checkout)
      throw new HubError(409, "FILE_SCOPE_CHANGED", "Рабочая копия изменилась.");
    const spec = JSON.stringify({
      projectId: bound.project.id,
      checkout: bound.checkout,
      paths: body.paths,
    });
    const existing = db.prepare("SELECT * FROM project_file_archives WHERE id=?").get(id);
    if (existing && existing.spec !== spec)
      throw new HubError(
        409,
        "ARCHIVE_CHANGED",
        "Для этого архива уже выбран другой набор файлов.",
      );
    if (existing && Number(existing.updatedAt) < Date.now() - 1800000) throw missing();
    if (existing && ["ready", "cancelled"].includes(String(existing.state))) return state(req);
    if (running.has(id)) {
      await running.get(id);
      return state(req);
    }
    if (running.size || building >= 2)
      throw new HubError(409, "ARCHIVE_BUSY", "Другой архив ещё готовится. Повтори немного позже.");
    // Admit durably before any asynchronous cleanup so cancellation can always find this job.
    db.prepare(
      "INSERT INTO project_file_archives(id,spec,state,updatedAt) VALUES(?,?,'building',?) ON CONFLICT(id) DO UPDATE SET state='building',updatedAt=excluded.updatedAt",
    ).run(id, spec, Date.now());
    const job = (async () => {
      building++;
      try {
        // Bounded per-account cache; only completed/inactive archives can be evicted.
        const rows = db
          .prepare(
            "SELECT id,updatedAt FROM project_file_archives WHERE id<>? ORDER BY updatedAt DESC",
          )
          .all(id);
        for (let i = 0; i < rows.length; i++) {
          const old = String(rows[i]!.id);
          if (
            old === id ||
            running.has(old) ||
            (i < 3 && Number(rows[i]!.updatedAt) >= Date.now() - 1800000)
          )
            continue;
          await unlink(file(old)).catch(() => {});
          db.prepare("DELETE FROM project_file_archives WHERE id=?").run(old);
        }
        if (access(req).checkout !== bound.checkout)
          throw new HubError(409, "FILE_SCOPE_CHANGED", "Рабочая копия изменилась.");
        if (read(req).row.state === "cancelled") return state(req);
        const value = await runFileTools(bound.machine, bound.project.workingDirectory, {
          op: "archive",
          path: "",
          paths: body.paths,
        });
        if (read(req).row.state === "cancelled") return state(req);
        if (!value.entries || value.entries.length > 2000 || value.size > 32 * 1024 * 1024)
          throw new HubError(400, "FILE_ARCHIVE_LARGE", "Выбрано слишком много файлов для ZIP.");
        const entries: Record<string, Uint8Array> = Object.create(null);
        for (const entry of value.entries)
          entries[entry.path] =
            entry.data === undefined ? new Uint8Array() : Buffer.from(entry.data, "base64");
        // Store mode avoids expensive compression on the Hub event loop; bytes remain exact.
        const bytes = zipSync(entries, { level: 0 });
        if (bytes.length > 40 * 1024 * 1024)
          throw new HubError(400, "FILE_ARCHIVE_LARGE", "Архив слишком велик.");
        await writeFile(file(id) + ".tmp", bytes, { mode: 0o600, flush: true });
        if (read(req).row.state === "cancelled") return state(req);
        await rename(file(id) + ".tmp", file(id));
        if (read(req).row.state === "cancelled") {
          await unlink(file(id)).catch(() => {});
          return state(req);
        }
        db.prepare(
          "UPDATE project_file_archives SET state='ready',bytes=?,updatedAt=? WHERE id=?",
        ).run(bytes.length, Date.now(), id);
        return state(req);
      } finally {
        building--;
        await unlink(file(id) + ".tmp").catch(() => {});
      }
    })();
    running.set(id, job);
    try {
      return await job;
    } finally {
      running.delete(id);
    }
  });
  app.get(route + "/content", async (req, reply) => {
    const item = read(req);
    if (item.row.state !== "ready") throw missing();
    const info = await stat(file(item.id)).catch(() => null);
    if (!info || info.size !== Number(item.row.bytes)) throw missing();
    read(req);
    const result = state(req);
    return reply
      .header("Cache-Control", "no-store")
      .header("X-Content-Type-Options", "nosniff")
      .header(
        "Content-Disposition",
        `attachment; filename="files.zip"; filename*=UTF-8''${encodeURIComponent(result.name!).replaceAll("'", "%27")}`,
      )
      .type("application/zip")
      .send(createReadStream(file(item.id)));
  });
}
