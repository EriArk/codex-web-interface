import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, posix, win32 } from "node:path";
import { copyProjectFile, inspectProject } from "@codex-web/machines";
import { type CachedProjectGit, HubError, type ProjectGit } from "@codex-web/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { registerFileTools } from "./file-tools.js";
import type { Sessions } from "./sessions.js";

export function registerProjectInspector(app: FastifyInstance, sessions: Sessions) {
  registerFileTools(app, sessions);
  const path = z.string().max(2048).default("");
  let pending = 0;
  const readers: { grant: () => void; timer: ReturnType<typeof setTimeout> }[] = [];
  const busy = () =>
    new HubError(
      429,
      "PROJECT_READER_BUSY",
      "Чтение уже идёт. Попробуй ещё раз через несколько секунд.",
    );
  const bounded = async <T>(work: () => Promise<T>) => {
    if (pending < 2) pending++;
    else
      await new Promise<void>((resolve, reject) => {
        if (readers.length >= 8) {
          reject(busy());
          return;
        }
        const entry = {
          grant: resolve,
          timer: setTimeout(() => {
            const index = readers.indexOf(entry);
            if (index >= 0) readers.splice(index, 1);
            reject(busy());
          }, 20000),
        };
        readers.push(entry);
      });
    try {
      return await work();
    } finally {
      const next = readers.shift();
      if (next) {
        clearTimeout(next.timer);
        next.grant();
      } else pending--;
    }
  };
  const context = (req: FastifyRequest) => {
    const { id } = z.object({ id: z.string().min(1).max(100) }).parse(req.params);
    const project = sessions.project(id);
    if (project.unassigned) throw new HubError(400, "PROJECT_REQUIRED", "Сначала выбери проект.");
    return { project, machine: sessions.catalog.machine(project.machineId) };
  };
  app.get("/api/projects/:id/files", async (req) => {
    const { project, machine } = context(req),
      q = z
        .object({
          path,
          offset: z.coerce.number().int().min(0).max(5000).default(0),
          search: z.string().max(120).default(""),
          sort: z.enum(["name", "modified", "size"]).default("name"),
          reveal: z.string().max(255).optional(),
        })
        .strict()
        .parse(req.query);
    return bounded(() =>
      inspectProject(machine, project.workingDirectory, { op: "directory", ...q }),
    );
  });
  app.get("/api/projects/:id/git", async (req) => {
    const { project, machine } = context(req);
    z.object({}).strict().parse(req.query);
    try {
      const git = (await bounded(() =>
        inspectProject(machine, project.workingDirectory, { op: "git" }),
      )) as ProjectGit;
      const summary: CachedProjectGit = {
        checkedAt: Date.now(),
        root: project.workingDirectory,
        repository: git.repository,
        branch: git.branch,
        detached: git.detached,
        dirty: git.dirty,
        changed: git.changes.length + (git.hiddenCount ?? 0),
      };
      sessions.store.setPreferences({
        projectGit: {
          ...((sessions.store.preferences().projectGit as Record<string, CachedProjectGit>) ?? {}),
          [project.id]: summary,
        },
      });
      return git;
    } catch (error) {
      const previous = (
        sessions.store.preferences().projectGit as Record<string, CachedProjectGit>
      )?.[project.id];
      if (previous)
        sessions.store.setPreferences({
          projectGit: {
            ...(sessions.store.preferences().projectGit as Record<string, CachedProjectGit>),
            [project.id]: { ...previous, error: true },
          },
        });
      throw error;
    }
  });
  for (const op of ["repository", "releases"] as const) {
    app.get(`/api/projects/:id/git/${op}`, async (req) => {
      const { project, machine } = context(req);
      z.object({}).strict().parse(req.query);
      return bounded(() => inspectProject(machine, project.workingDirectory, { op }));
    });
  }
  app.get("/api/projects/:id/git/diff", async (req) => {
    const { project, machine } = context(req),
      q = z
        .object({ path: path.refine((p) => !!p), staged: z.enum(["0", "1"]).default("0") })
        .strict()
        .parse(req.query);
    return bounded(() =>
      inspectProject(machine, project.workingDirectory, {
        op: "diff",
        path: q.path,
        staged: q.staged === "1",
      }),
    );
  });
  app.get("/api/projects/:id/files/content", async (req, reply) => {
    const { project, machine } = context(req),
      q = z
        .object({ path: path.refine((p) => !!p), version: z.enum(["index"]).optional() })
        .strict()
        .parse(req.query);
    const bytes = await bounded(async () => {
      if (q.version === "index") {
        const value = (await inspectProject(machine, project.workingDirectory, {
          op: "index-file",
          path: q.path,
        })) as { data: string; oid: string };
        reply.header("ETag", '"' + value.oid + '"');
        return Buffer.from(value.data, "base64");
      }
      const validated = (await inspectProject(machine, project.workingDirectory, {
        op: "file",
        path: q.path,
      })) as { path: string };
      // Transfer through disk with checksum verification; preview limits never cap downloads.
      const directory = join(sessions.config.hub.resultsPath, "file-downloads");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const temp = await mkdtemp(join(directory, "read-")),
        target = join(temp, "content");
      try {
        const result = await copyProjectFile(
          machine,
          project.workingDirectory,
          validated.path.replaceAll("%", "%25"),
          target,
          sessions.config.hub.storage.attachmentBytes,
        );
        const current = context(req);
        if (
          current.project.workingDirectory !== project.workingDirectory ||
          current.machine.id !== machine.id
        )
          throw new HubError(409, "FILE_SCOPE_CHANGED", "Рабочая копия изменилась.");
        if (reply.raw.destroyed) throw new Error("DOWNLOAD_CANCELLED");
        const stream = createReadStream(target);
        stream.once("close", () => {
          void rm(temp, { recursive: true, force: true });
        });
        reply.raw.once("close", () => stream.destroy());
        reply.header("Content-Length", result.bytes).header("ETag", '"' + result.sha256 + '"');
        return stream;
      } catch (error) {
        await rm(temp, { recursive: true, force: true });
        throw error;
      }
    });
    const name = posix.basename(q.path);
    return reply
      .header("Cache-Control", "no-store")
      .header("X-Content-Type-Options", "nosniff")
      .header(
        "Content-Disposition",
        `attachment; filename="file"; filename*=UTF-8''${encodeURIComponent(name).replaceAll("'", "%27")}`,
      )
      .type("application/octet-stream")
      .send(bytes);
  });
  app.get("/api/projects/:id/files/saved", async (req) => {
    const { project, machine } = context(req),
      q = z
        .object({ path: path.refine((p) => !!p) })
        .strict()
        .parse(req.query);
    const paths = machine.type === "ssh-windows" ? win32 : posix,
      full = paths.resolve(project.workingDirectory, q.path);
    const rows = sessions.store.db
      .prepare(
        "SELECT a.id,f.name,f.sourcePath FROM artifact_files f JOIN artifacts a ON a.id=f.id JOIN threads t ON t.id=a.threadId WHERE t.projectId=? ORDER BY a.createdAt DESC",
      )
      .iterate(project.id);
    let row: Record<string, unknown> | undefined;
    for (const candidate of rows) {
      if (
        sessions.catalog.pathKey(machine, String(candidate.sourcePath)) ===
        sessions.catalog.pathKey(machine, full)
      ) {
        row = candidate;
        break;
      }
    }
    return row ? { url: `/api/artifacts/${row.id}`, name: String(row.name) } : null;
  });
}
