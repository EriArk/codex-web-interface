import type { NotebookScope, TaskProject, TaskProjectsPage } from "@codex-web/shared";
import type { Sessions } from "./sessions.js";

const scopeKey = (s: NotebookScope) => (s ? `${s.client}:${s.projectId}` : "global");
export function workspaceProjects(sessions: Sessions, offset = 0): TaskProjectsPage {
  const projects = new Map<string, TaskProject>();
  // One saved association per project, independent of the visible task page.
  const saved = sessions.store.db
    .prepare(
      "SELECT scope FROM (SELECT scope,row_number() OVER (PARTITION BY scopeKey ORDER BY updatedAt DESC,id) AS n FROM (SELECT scope,scopeKey,updatedAt,id FROM workspace_tasks UNION ALL SELECT scope,scopeKey,updatedAt,id FROM workspace_notes) WHERE scope IS NOT NULL) WHERE n=1 LIMIT 5000",
    )
    .all();
  for (const row of saved) {
    const scope = JSON.parse(String(row.scope)) as NonNullable<NotebookScope>;
    projects.set(scopeKey(scope), {
      scope,
      availability: scope.client === "codex" ? "missing" : "unknown",
    });
  }
  const referenced = new Set(projects.keys());
  for (const p of sessions.catalog.projects()) {
    if (p.unassigned) continue;
    const scope = { client: "codex" as const, projectId: p.id, name: p.name };
    projects.set(scopeKey(scope), { scope, availability: "available" });
  }
  for (const row of sessions.store.db
    .prepare(
      "SELECT client,id,value FROM library_entities WHERE kind='project' ORDER BY client,id LIMIT 5000",
    )
    .all()) {
    const entry = JSON.parse(String(row.value)),
      key = `${row.client}:${row.id}`;
    if (entry.deleted && !referenced.has(key)) {
      projects.delete(key);
      continue;
    }
    const previous = projects.get(key);
    // Hidden/deleted entries without tasks do not clutter the task picker.
    if (!previous && (entry.deleted || row.client === "codex")) continue;
    const scope = {
      client: row.client as "codex" | "gpt",
      projectId: String(row.id),
      name: entry.name || previous?.scope.name || String(row.id),
    };
    projects.set(key, {
      scope,
      availability: entry.deleted
        ? "missing"
        : entry.archived
          ? "archived"
          : (previous?.availability ?? "unknown"),
    });
  }
  const items = [...projects.values()].sort(
    (a, b) =>
      a.scope.name.localeCompare(b.scope.name, "ru") ||
      scopeKey(a.scope).localeCompare(scopeKey(b.scope)),
  );
  return {
    items: items.slice(offset, offset + 100),
    nextOffset: items.length > offset + 100 ? offset + 100 : null,
  };
}
