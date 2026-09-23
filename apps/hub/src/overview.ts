import {
  type CachedProjectGit,
  HubError,
  type MachineProbe,
  type OverviewResult,
  type OverviewThread,
  type ProjectOverview,
} from "@codex-web/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Notebook } from "./notebook.js";
import type { ProjectActions } from "./project-actions.js";
import { ProjectCores } from "./project-core.js";
import { ProjectPlans } from "./project-plans.js";
import type { Sessions } from "./sessions.js";
import { WorkspaceTasks } from "./tasks.js";

const live = "('starting','running','waiting_approval')";
export class ProjectHome {
  readonly notes: Notebook;
  readonly tasks: WorkspaceTasks;
  constructor(
    readonly sessions: Sessions,
    readonly work?: ProjectActions,
  ) {
    this.notes = new Notebook(sessions);
    this.tasks = new WorkspaceTasks(sessions);
  }
  get(client: "codex" | "gpt", id: string): ProjectOverview {
    const db = this.sessions.store.db,
      project = client === "codex" ? this.sessions.project(id) : undefined;
    if (project?.unassigned) throw new HubError(400, "PROJECT_REQUIRED", "Выбери проект.");
    const saved =
      client === "gpt"
        ? db
            .prepare(
              "SELECT value FROM library_entities WHERE client='gpt' AND kind='project' AND id=?",
            )
            .get(id)
        : undefined;
    const metadata = saved ? JSON.parse(String(saved.value)) : undefined;
    if (metadata?.deleted) throw new HubError(404, "PROJECT_NOT_FOUND", "Проект удалён.");
    const key = `${client}:${id}`,
      value: ProjectOverview = {
        scope: { client, projectId: id, name: project?.name ?? metadata?.name ?? "Проект GPT" },
        generatedAt: Date.now(),
        threads: [],
        notes: this.notes.list(key, "", 0, 3).items,
        tasks: this.tasks.list(key, "open", "", 0, "", 4).items,
        pins: this.notes.pins(key, 0, 3).items,
        results: [],
      };
    value.plans = new ProjectPlans(this.sessions).list(key, "", 0).items.slice(0, 3);
    if (this.work) {
      value.reviews = this.work.reviews.list(key).items.slice(0, 4);
      value.currentChat = this.work.context.current(value.scope!);
      const report = this.work.context.latestReport(value.scope!);
      if (report)
        value.latestReport = {
          id: report.id,
          createdAt: report.createdAt,
          excerpt: report.body.slice(0, 240),
        };
    }
    const core = new ProjectCores(this.sessions).get(value.scope!);
    value.core = {
      revision: core.revision,
      purpose: core.value.purpose.slice(0, 240),
      updatedAt: core.updatedAt,
    };
    if (!project) return value;
    const where =
      "t.projectId=? AND t.archived=0 AND t.diagnostic=0 AND NOT EXISTS(SELECT 1 FROM library_entities e WHERE e.client='codex' AND e.kind='thread' AND e.id=t.codexThreadId AND (json_extract(e.value,'$.deleted')=1 OR json_extract(e.value,'$.archived')=1))";
    const rows = db
      .prepare(
        `SELECT t.id,t.title,t.status,t.updatedAt,t.status IN ${live} AS active,(t.status NOT IN ${live} AND t.completedSeq>t.seenSeq) AS unread FROM threads t WHERE ${where} ORDER BY active DESC,COALESCE(t.activityAt,t.updatedAt) DESC,t.id LIMIT 4`,
      )
      .all(id);
    value.threads = rows.map((r) => ({
      id: String(r.id),
      title: String(r.title),
      status: String(r.status),
      updatedAt: String(r.updatedAt),
      active: !!r.active,
      unread: !!r.unread,
    })) satisfies OverviewThread[];
    const counts = db
      .prepare(
        `SELECT sum(t.status IN ${live}) AS active,sum(t.status NOT IN ${live} AND t.completedSeq>t.seenSeq) AS unread FROM threads t WHERE ${where}`,
      )
      .get(id);
    value.activity = { active: Number(counts?.active ?? 0), unread: Number(counts?.unread ?? 0) };
    const results = db
      .prepare(
        `SELECT r.id,r.threadId,r.turnId,r.title,r.type,r.createdAt,CASE WHEN r.type='image' THEN json_extract(r.payload,'$.url') END AS imageUrl FROM results r JOIN threads t ON t.id=r.threadId WHERE ${where} ORDER BY r.rowid DESC LIMIT 4`,
      )
      .all(id);
    value.results = results.map((r) => {
      const result: OverviewResult = {
        id: String(r.id),
        threadId: String(r.threadId),
        turnId: r.turnId ? String(r.turnId) : undefined,
        title: String(r.title),
        type: String(r.type),
        createdAt: String(r.createdAt),
      };
      const path = String(r.imageUrl ?? "");
      const match = /^\/api\/artifacts\/([a-f0-9-]{36})$/.exec(path);
      if (
        match &&
        db.prepare("SELECT 1 FROM artifacts WHERE id=? AND mime LIKE 'image/%'").get(match[1]!)
      )
        result.imageUrl = path;
      return result;
    });
    const machine = this.sessions.catalog.machine(project.machineId),
      prefs = this.sessions.store.preferences();
    const cached = (
      prefs.machineHealth as Record<string, { probe: MachineProbe; lastSeenAt?: number }>
    )?.[machine.id];
    value.machine = {
      id: machine.id,
      name: machine.name,
      checkedAt: cached?.probe.checkedAt,
      lastSeenAt: cached?.lastSeenAt,
      online: cached?.probe.online,
      stale: !cached || Date.now() - cached.probe.checkedAt > 60000,
      codex: cached
        ? cached.probe.checks.some((c) => c.layer === "protocol" && c.state === "ok")
        : undefined,
      remoteAvailable: !!machine.remote,
    };
    const git = (prefs.projectGit as Record<string, CachedProjectGit>)?.[id];
    if (git && git.root === project.workingDirectory) {
      const { root: _root, ...summary } = git;
      value.git = { ...summary, stale: !!git.error || Date.now() - git.checkedAt > 60000 };
    }
    return value;
  }
}
export function registerProjectOverview(
  app: FastifyInstance,
  sessions: Sessions,
  work?: ProjectActions,
) {
  const home = new ProjectHome(sessions, work);
  app.get("/api/workspace/overview", (req) => {
    const q = z
      .object({
        client: z.enum(["codex", "gpt"]),
        projectId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
      })
      .strict()
      .parse(req.query);
    return home.get(q.client, q.projectId);
  });
  return home;
}
