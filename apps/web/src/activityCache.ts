import type { CollaborationSpace, SpaceActivityPage } from "@codex-web/shared";
import { pageWorkspace, accountSessionStorage as storage } from "./accountStorage";

export type ActivityView = {
  pages: SpaceActivityPage[];
  project: string;
  author: string;
  limit: number;
  sources: Record<string, string>;
  groups: Record<string, string>;
  expanded: Record<string, boolean>;
  scroll: number;
};
const empty = (): ActivityView => ({
  pages: [],
  project: "",
  author: "",
  limit: 20,
  sources: {},
  groups: {},
  expanded: {},
  scroll: 0,
});
const storageKey = "activity-views";
type Entry = { scope: string; at: number; view: ActivityView };
export const activityScope = (space: CollaborationSpace) =>
  JSON.stringify([
    space.id,
    space.revision,
    space.projects
      .filter((p) => p.access !== "none")
      .map((p) => [p.id, p.personalProjectId, p.repository]),
  ]);
function entries(): Entry[] {
  try {
    return (JSON.parse(storage.getItem(storageKey) ?? "[]") as Entry[]).filter(
      (v) => Date.now() - v.at < 30 * 60_000,
    );
  } catch {
    return [];
  }
}
export function readActivityView(scope: string): ActivityView {
  return entries().find((v) => v.scope === scope)?.view ?? empty();
}
export function saveActivityView(scope: string, view: ActivityView) {
  try {
    if (pageWorkspace && sessionStorage.getItem("codex-workspace-identity") !== pageWorkspace)
      return;
    const keys = new Set(view.pages.flatMap((p) => p.items.map((v) => p.projectId + v.key))),
      groups = Object.fromEntries(Object.entries(view.groups).filter(([key]) => keys.has(key))),
      ids = new Set(Object.values(groups));
    const bounded = {
      ...view,
      groups,
      sources: Object.fromEntries(Object.entries(view.sources).filter(([key]) => ids.has(key))),
      expanded: Object.fromEntries(Object.entries(view.expanded).filter(([key]) => ids.has(key))),
    };
    const values = [
      { scope, at: Date.now(), view: bounded },
      ...entries().filter((v) => v.scope !== scope),
    ].slice(0, 8);
    while (
      values.length &&
      new TextEncoder().encode(JSON.stringify(values)).byteLength > 2 * 1024 * 1024
    )
      values.pop();
    storage.setItem(storageKey, JSON.stringify(values));
  } catch {
    /* A full session store must not discard the mounted feed. */
  }
}
export function mergeActivityPage(
  old: SpaceActivityPage | undefined,
  next: SpaceActivityPage,
): SpaceActivityPage {
  if (!next.delta || old?.repositoryId !== next.repositoryId) return { ...next, delta: false };
  const items = new Map(old.items.map((v) => [v.key, v]));
  for (const v of next.items) items.set(v.key, v);
  const keys = next.keys ?? [...items.keys()],
    social = { ...old.social, ...next.social };
  return {
    ...next,
    delta: false,
    items: keys.flatMap((key) => (items.has(key) ? [items.get(key)!] : [])),
    social: Object.fromEntries(keys.filter((key) => social[key]).map((key) => [key, social[key]!])),
  };
}
