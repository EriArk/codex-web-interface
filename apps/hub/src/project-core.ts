import {
  type CoreHistoryPage,
  type CoreWrite,
  coreFields,
  coreLabels,
  coreWriteSchema,
  emptyCore,
  HubError,
  type ProjectCore,
  type ProjectScope,
  projectScopeSchema,
} from "@codex-web/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Sessions } from "./sessions.js";
export const projectKey = (scope: ProjectScope) => `${scope.client}:${scope.projectId}`;
export class ProjectCores {
  constructor(readonly sessions: Sessions) {}
  private get db() {
    return this.sessions.store.db;
  }
  get(scope: ProjectScope): ProjectCore {
    const row = this.db
      .prepare("SELECT * FROM project_cores WHERE scopeKey=?")
      .get(projectKey(scope));
    return row
      ? {
          scope: JSON.parse(String(row.scope)),
          value: JSON.parse(String(row.value)),
          revision: Number(row.revision),
          createdAt: Number(row.createdAt),
          updatedAt: Number(row.updatedAt),
        }
      : { scope, value: { ...emptyCore }, revision: 0, createdAt: 0, updatedAt: 0 };
  }
  save(input: CoreWrite): ProjectCore {
    const current = this.get(input.scope),
      key = projectKey(input.scope);
    if (current.revision && JSON.stringify(current.value) === JSON.stringify(input.value))
      return current;
    if (current.revision !== input.revision)
      throw new HubError(
        409,
        "CORE_CONFLICT",
        "Основа проекта изменилась на другом устройстве. Твой текст сохранён в черновике.",
      );
    if (
      !current.revision &&
      Number(this.db.prepare("SELECT count(*) n FROM project_cores").get()?.n) >= 500
    )
      throw new HubError(409, "CORE_LIMIT", "Достигнут лимит основ проектов: 500.");
    const now = Date.now(),
      revision = current.revision + 1,
      value = JSON.stringify(input.value);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          "INSERT INTO project_cores VALUES(?,?,?,?,?,?) ON CONFLICT(scopeKey) DO UPDATE SET scope=excluded.scope,value=excluded.value,revision=excluded.revision,updatedAt=excluded.updatedAt",
        )
        .run(key, JSON.stringify(input.scope), value, revision, current.createdAt || now, now);
      this.db
        .prepare("INSERT INTO project_core_history VALUES(?,?,?,?)")
        .run(key, revision, value, now);
      this.db
        .prepare(
          "DELETE FROM project_core_history WHERE scopeKey=? AND revision NOT IN (SELECT revision FROM project_core_history WHERE scopeKey=? ORDER BY revision DESC LIMIT 40)",
        )
        .run(key, key);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return this.get(input.scope);
  }
  history(scope: ProjectScope, offset = 0): CoreHistoryPage {
    const rows = this.db
      .prepare(
        "SELECT revision,createdAt FROM project_core_history WHERE scopeKey=? ORDER BY revision DESC LIMIT 11 OFFSET ?",
      )
      .all(projectKey(scope), offset);
    return {
      items: rows
        .slice(0, 10)
        .map((r) => ({ revision: Number(r.revision), createdAt: Number(r.createdAt) })),
      nextOffset: rows.length > 10 ? offset + 10 : null,
    };
  }
  version(scope: ProjectScope, revision: number) {
    const row = this.db
      .prepare("SELECT value,createdAt FROM project_core_history WHERE scopeKey=? AND revision=?")
      .get(projectKey(scope), revision);
    if (!row) throw new HubError(404, "CORE_VERSION_MISSING", "Эта версия уже недоступна.");
    return {
      ...this.get(scope),
      value: JSON.parse(String(row.value)),
      revision,
      updatedAt: Number(row.createdAt),
    } as ProjectCore;
  }
  restore(scope: ProjectScope, revision: number, version: number) {
    return this.save({ scope, revision, value: this.version(scope, version).value });
  }
  text(scope: ProjectScope) {
    const core = this.get(scope);
    return core.revision
      ? [
          "# Основа проекта (подтверждена владельцем, версия " + core.revision + ")",
          ...coreFields
            .filter((k) => core.value[k].trim())
            .map((k) => "## " + coreLabels[k] + "\n" + core.value[k]),
        ].join("\n\n")
      : "";
  }
}
export function registerProjectCores(app: FastifyInstance, sessions: Sessions) {
  const cores = new ProjectCores(sessions),
    query = projectScopeSchema.omit({ name: true });
  const scope = (v: unknown) => ({ ...query.parse(v), name: "Проект" });
  app.get("/api/workspace/core", (req) => cores.get(scope(req.query)));
  app.put("/api/workspace/core", (req) => cores.save(coreWriteSchema.parse(req.body)));
  app.get("/api/workspace/core/history", (req) => {
    const q = query
      .extend({ offset: z.coerce.number().int().min(0).max(40).default(0) })
      .parse(req.query);
    return cores.history({ ...q, name: "Проект" }, q.offset);
  });
  app.get("/api/workspace/core/version", (req) => {
    const q = query.extend({ revision: z.coerce.number().int().positive() }).parse(req.query);
    return cores.version({ ...q, name: "Проект" }, q.revision);
  });
  app.post("/api/workspace/core/restore", (req) => {
    const b = z
      .object({
        scope: projectScopeSchema,
        revision: z.number().int().min(0),
        version: z.number().int().positive(),
        confirm: z.literal(true),
      })
      .strict()
      .parse(req.body);
    return cores.restore(b.scope, b.revision, b.version);
  });
  return cores;
}
