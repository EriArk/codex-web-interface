import { createHash } from "node:crypto";
import { authorizeMachine, runProjectGitHub } from "@codex-web/machines";
import { type GitHubWorkObservation, HubError, type SpaceActivityPage } from "@codex-web/shared";
import type { createApp } from "./app.js";
import type { CollaborationSpaces } from "./collaboration-spaces.js";
import type { GitHubProbe } from "./team-github.js";

const missing = () => new HubError(404, "ACTIVITY_UNAVAILABLE", "Активность проекта недоступна.");
/** A bounded, viewer-private source index; membership never substitutes for GitHub access. */
export class SpaceActivity {
  private pending = new Map<string, Promise<SpaceActivityPage>>();
  constructor(
    private spaces: CollaborationSpaces,
    private personal: (id: string) => Promise<{ runtime: Awaited<ReturnType<typeof createApp>> }>,
    private probe: GitHubProbe = runProjectGitHub,
  ) {
    spaces.team.db.exec(`CREATE TABLE IF NOT EXISTS space_activity_index (
      userId TEXT NOT NULL, spaceId TEXT NOT NULL REFERENCES collaboration_spaces(id) ON DELETE CASCADE,
      projectId TEXT NOT NULL, binding TEXT NOT NULL, checkedAt INTEGER NOT NULL, data TEXT NOT NULL,
      PRIMARY KEY(userId,spaceId,projectId))`);
  }
  private async context(actor: string, spaceId: string, projectId: string) {
    const space = this.spaces.access(actor, spaceId);
    const p = space.projects.find((p) => p.id === projectId);
    if (!p || (p.ownerId !== actor && !p.grants[actor])) throw missing();
    const copy = p.copies[actor];
    if (!copy)
      throw new HubError(409, "ACTIVITY_COPY_REQUIRED", "Подключи свою рабочую копию проекта.");
    const { runtime } = await this.personal(actor);
    const local = runtime.sessions.project(copy);
    runtime.projectWork.context.assertProject({
      client: "codex",
      projectId: copy,
      name: local.name,
    });
    const machine = runtime.sessions.catalog.machine(local.machineId);
    authorizeMachine(machine);
    const binding = createHash("sha256")
      .update(
        JSON.stringify([
          this.spaces.team.registry.active(actor).executionEpoch,
          space.revision,
          p.repository,
          copy,
          local.workingDirectory,
          machine,
        ]),
      )
      .digest("hex");
    return {
      binding,
      machine,
      root: local.workingDirectory,
      repository: p.repository.replace("https://github.com/", ""),
    };
  }
  async page(actor: string, spaceId: string, projectId: string, source?: string) {
    this.spaces.access(actor, spaceId);
    const key = JSON.stringify([actor, spaceId, projectId, source]);
    const existing = this.pending.get(key);
    if (existing) return existing;
    if (this.pending.size >= 12) throw new HubError(429, "ACTIVITY_BUSY", "Повтори чуть позже.");
    const task = this.read(actor, spaceId, projectId, source);
    this.pending.set(key, task);
    try {
      return await task;
    } finally {
      this.pending.delete(key);
    }
  }
  private async read(
    actor: string,
    spaceId: string,
    projectId: string,
    source?: string,
  ): Promise<SpaceActivityPage> {
    const c = await this.context(actor, spaceId, projectId),
      db = this.spaces.team.db;
    // Expire unused private indexes and bound each project to 200 source references.
    db.prepare("DELETE FROM space_activity_index WHERE checkedAt < ?").run(
      Date.now() - 7 * 86400000,
    );
    const row = db
      .prepare("SELECT * FROM space_activity_index WHERE userId=? AND spaceId=? AND projectId=?")
      .get(actor, spaceId, projectId);
    const cached =
      row?.binding === c.binding ? (JSON.parse(String(row.data)) as SpaceActivityPage) : null;
    const recent = cached && Date.now() - cached.checkedAt < 60000;
    // Even a cached page/open rechecks the viewer's current native GitHub account and repository access.
    const value = (await this.probe(c.machine, c.root, {
      op: "observe",
      repository: c.repository,
      query: { kind: recent || source ? "identity" : "activity" },
    })) as GitHubWorkObservation;
    if ((await this.context(actor, spaceId, projectId)).binding !== c.binding) throw missing();
    if (
      value.access === "unavailable" ||
      !value.repositoryId ||
      value.repository.toLowerCase() !== c.repository.toLowerCase()
    ) {
      db.prepare(
        "DELETE FROM space_activity_index WHERE userId=? AND spaceId=? AND projectId=?",
      ).run(actor, spaceId, projectId);
      throw missing();
    }
    // A repository recreated under the same name must never inherit old references.
    const previous = cached?.repositoryId === value.repositoryId ? cached : null;
    if (source) {
      const item = previous?.items.find((v) => v.key === source);
      if (!item) throw missing();
      return { ...previous!, items: [item] };
    }
    if (recent && previous) return previous;
    if (!value.activity) throw missing();
    const items = new Map((previous?.items ?? []).map((item) => [item.key, item]));
    for (const item of value.activity) items.set(item.key, item);
    const result: SpaceActivityPage = {
      projectId,
      repository: c.repository,
      repositoryId: value.repositoryId,
      checkedAt: Date.now(),
      items: [...items.values()]
        .sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || a.key.localeCompare(b.key))
        .slice(0, 200),
    };
    db.prepare(`INSERT INTO space_activity_index VALUES(?,?,?,?,?,?) ON CONFLICT(userId,spaceId,projectId)
      DO UPDATE SET binding=excluded.binding,checkedAt=excluded.checkedAt,data=excluded.data`).run(
      actor,
      spaceId,
      projectId,
      c.binding,
      result.checkedAt,
      JSON.stringify(result),
    );
    return result;
  }
}
