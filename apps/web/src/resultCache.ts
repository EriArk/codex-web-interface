import type { ResultPage } from "@codex-web/shared";

// Only already received first-page metadata. Never fetch assets or retain previews/Blobs.
const pages = new Map<string, { page: ResultPage; bytes: number; usedAt: number }>();
let epoch = 0;
export const resultCacheEpoch = () => epoch;
export function clearResultCache() {
  epoch++;
  pages.clear();
}
export function cachedResults(scope: string) {
  const entry = pages.get(scope);
  if (!entry) return undefined;
  if (Date.now() - entry.usedAt >= 30 * 60000) {
    pages.delete(scope);
    return undefined;
  }
  pages.delete(scope);
  entry.usedAt = Date.now();
  pages.set(scope, entry);
  return entry.page;
}
export function rememberResults(scope: string, page: ResultPage, requestEpoch: number) {
  if (requestEpoch !== epoch) return;
  const serialized = JSON.stringify(page),
    bytes = serialized.length * 2;
  // Embedded binary content must not turn the navigation cache into a file cache.
  if (bytes > 1024 ** 2 || /data:[^\s"<>]*;base64,/i.test(serialized)) {
    pages.delete(scope);
    return;
  }
  pages.delete(scope);
  pages.set(scope, { page, bytes, usedAt: Date.now() });
  let total = [...pages.values()].reduce((sum, entry) => sum + entry.bytes, 0);
  for (const [key, entry] of pages) {
    if (pages.size <= 64 && total <= 4 * 1024 ** 2) break;
    pages.delete(key);
    total -= entry.bytes;
  }
}
if (typeof window !== "undefined")
  window.addEventListener("private-session-ended", clearResultCache);
