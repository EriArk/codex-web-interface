import type { SpaceActivityPage } from "@codex-web/shared";
import { pageWorkspace, accountSessionStorage as storage } from "./accountStorage";

const key = "github-attention-view";
export type AttentionView = { pages: Record<string, SpaceActivityPage>; scroll: number };
export function readAttentionView(scope: string): AttentionView {
  try {
    const value = JSON.parse(storage.getItem(key) ?? "null");
    if (value?.scope === scope && Date.now() - value.at < 30 * 60_000)
      return { pages: value.pages, scroll: value.scroll ?? 0 };
  } catch {}
  return { pages: {}, scroll: 0 };
}
export function saveAttentionView(scope: string, view: AttentionView) {
  try {
    if (pageWorkspace && sessionStorage.getItem("codex-workspace-identity") !== pageWorkspace)
      return;
    const pages = { ...view.pages };
    const data = () => JSON.stringify({ scope, at: Date.now(), pages, scroll: view.scroll });
    while (Object.keys(pages).length && new TextEncoder().encode(data()).byteLength > 512 * 1024)
      delete pages[Object.keys(pages)[0]!];
    storage.setItem(key, data());
  } catch {
    /* Storage pressure must not discard mounted notifications. */
  }
}
