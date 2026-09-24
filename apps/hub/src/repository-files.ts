import { createHash } from "node:crypto";
import { inspectProject, runProjectGitHub } from "@codex-web/machines";
import {
  type GitHubWorkObservation,
  type GitHubWorkReceipt,
  githubWorkQuerySchema,
  HubError,
  type ProjectRepository,
  repositoryEditInput,
} from "@codex-web/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { IssueDrawer } from "./issue-drawer.js";
import type { Sessions } from "./sessions.js";

const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const changed = () =>
  new HubError(
    409,
    "GITHUB_FILE_CHANGED",
    "Репозиторий, файл или доступ изменились. Обнови сравнение; черновик сохранён.",
  );
type Saved = {
  id: string;
  projectId: string;
  binding: string;
  repository: string;
  input: z.infer<typeof repositoryEditInput>;
  repositoryId: number;
  identityId: number;
  receipt?: GitHubWorkReceipt;
  state: string;
};
export function registerRepositoryFiles(
  app: FastifyInstance,
  sessions: Sessions,
  drawer: IssueDrawer,
  probe = runProjectGitHub,
  inspect = inspectProject,
) {
  const db = sessions.store.db,
    busy = new Map<string, Promise<unknown>>();
  db.exec(
    "CREATE TABLE IF NOT EXISTS repository_file_operations(id TEXT PRIMARY KEY,projectId TEXT NOT NULL,value TEXT NOT NULL)",
  );
  const put = (v: Saved) => {
    db.prepare("INSERT OR REPLACE INTO repository_file_operations VALUES(?,?,?)").run(
      v.id,
      v.projectId,
      JSON.stringify(v),
    );
    return v;
  };
  const context = async (id: string) => {
    const scope = drawer.scope(id),
      binding = hash(scope),
      machine = sessions.catalog.machine(scope.machineId);
    const repo = (await inspect(machine, scope.root, { op: "repository" })) as ProjectRepository;
    const repository = repo.remote?.url?.match(
      /^(?:https:\/\/github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/,
    )?.[1];
    if (!repository || binding !== hash(drawer.scope(id))) throw changed();
    const authority = scope.authority as { repository?: string } | null;
    if (
      authority?.repository &&
      authority.repository.toLowerCase() !== `https://github.com/${repository}`.toLowerCase()
    )
      throw changed();
    return { machine, root: scope.root, repository, binding };
  };
  const params = (v: unknown) =>
    z.object({ project: z.string().min(1).max(120), id: z.string().uuid().optional() }).parse(v);
  const root = "/api/projects/:project/github-files";
  const serial = async <T>(project: string, fn: () => Promise<T>) => {
    if (busy.has(project))
      throw new HubError(409, "GITHUB_FILE_BUSY", "Дождись текущей операции GitHub.");
    const p = fn();
    busy.set(project, p);
    try {
      return await p;
    } finally {
      busy.delete(project);
    }
  };
  app.addHook("onClose", async () => {
    await Promise.allSettled(busy.values());
  });
  app.post(root + "/read", async (req) => {
    const id = params(req.params).project,
      c = await context(id),
      q = githubWorkQuerySchema.parse(req.body);
    if (q.kind !== "repository-files")
      throw new HubError(400, "GITHUB_FILE_REQUEST", "Неверный запрос файла.");
    const v = (await probe(c.machine, c.root, {
      op: "observe",
      repository: c.repository,
      query: q,
    })) as GitHubWorkObservation;
    if (c.binding !== hash(drawer.scope(id))) throw changed();
    return { ...v, binding: c.binding };
  });
  const own = (project: string, id: string) => {
    drawer.scope(project);
    const row = db
      .prepare("SELECT value FROM repository_file_operations WHERE id=? AND projectId=?")
      .get(id, project);
    if (!row) throw new HubError(404, "GITHUB_FILE_MISSING", "Сохранение недоступно.");
    return JSON.parse(String(row.value)) as Saved;
  };
  const accept = (v: Saved, r: GitHubWorkReceipt | null) => {
    if (
      !r ||
      r.id !== v.id ||
      hash(r.input) !== hash(v.input) ||
      r.snapshot.repositoryId !== v.repositoryId ||
      r.snapshot.identity.id !== v.identityId ||
      r.snapshot.repository.toLowerCase() !== v.repository.toLowerCase()
    )
      throw changed();
    if (v.receipt && r.fingerprint !== v.receipt.fingerprint) throw changed();
    v.receipt = r;
    v.state = r.state;
    return put(v);
  };
  app.post(root + "/:id/prepare", { bodyLimit: 512 * 1024 }, (req) => {
    const { project, id } = params(req.params);
    return serial(project, async () => {
      const body = z
          .object({
            input: repositoryEditInput,
            binding: z.string(),
            repositoryId: z.number().int().positive(),
            identityId: z.number().int().positive(),
          })
          .strict()
          .parse(req.body),
        c = await context(project);
      if (body.binding !== c.binding) throw changed();
      const old = db.prepare("SELECT value FROM repository_file_operations WHERE id=?").get(id!);
      if (old) {
        const v = own(project, id!);
        if (
          v.binding !== c.binding ||
          hash(v.input) !== hash(body.input) ||
          v.repositoryId !== body.repositoryId ||
          v.identityId !== body.identityId
        )
          throw changed();
        return v;
      }
      if (
        db
          .prepare(
            "SELECT 1 FROM repository_file_operations WHERE projectId=? AND json_extract(value,'$.state') IN ('preparing','running','unknown')",
          )
          .get(project)
      )
        throw new HubError(
          409,
          "GITHUB_FILE_PENDING",
          "Сначала проверь предыдущее сохранение GitHub.",
        );
      if (Number(db.prepare("SELECT count(*) n FROM repository_file_operations").get()!.n) >= 5000)
        throw new HubError(409, "GITHUB_FILE_CAPACITY", "Достигнут предел сохранений GitHub.");
      const v: Saved = {
        id: id!,
        projectId: project,
        repository: c.repository,
        ...body,
        state: "preparing",
      };
      put(v);
      try {
        const r = (await probe(c.machine, c.root, {
          op: "prepare",
          repository: c.repository,
          id: id!,
          input: body.input,
        })) as GitHubWorkReceipt;
        if (c.binding !== hash(drawer.scope(project))) throw changed();
        return accept(v, r);
      } catch (e) {
        v.state = "failed";
        put(v);
        throw e;
      }
    });
  });
  for (const action of ["confirm", "status"] as const)
    app.post(root + "/:id/" + action, (req) => {
      const { project, id } = params(req.params);
      return serial(project, async () => {
        const v = own(project, id!),
          c = await context(project);
        if (v.binding !== c.binding || v.repository !== c.repository) throw changed();
        const commit = action === "confirm" && v.state === "prepared";
        if (commit) {
          const b = z.object({ fingerprint: z.string() }).strict().parse(req.body);
          if (!v.receipt || b.fingerprint !== v.receipt.fingerprint) throw changed();
          v.state = "unknown";
          put(v);
        }
        try {
          const r = (await probe(
            c.machine,
            c.root,
            commit
              ? {
                  op: "apply",
                  repository: c.repository,
                  id: id!,
                  fingerprint: v.receipt!.fingerprint,
                }
              : { op: "status", repository: c.repository, id: id! },
          )) as GitHubWorkReceipt | null;
          if (c.binding !== hash(drawer.scope(project))) throw changed();
          if (!r && !v.receipt && (v.state === "preparing" || v.state === "failed")) {
            v.state = "failed";
            return put(v);
          }
          return accept(v, r);
        } catch (e) {
          if (commit) {
            v.state = "unknown";
            put(v);
          }
          throw e;
        }
      });
    });
  app.get(root + "/:id", (req) => {
    const p = params(req.params);
    return own(p.project, p.id!);
  });
}
