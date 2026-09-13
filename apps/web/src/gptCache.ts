import type { GptConversation, GptJob, GptMessage, GptModels, GptProject } from "@codex-web/shared";

export interface GptCachedChat {
  stale?: boolean;
  refreshMessage?: string;
  contextMessage?: string;
  hasNewer?: boolean;
  messages: GptMessage[];
  before: string | null;
  revision: string;
  prefix: string;
  anchor: string;
  checkedAt: number;
  scrollTop: number;
  sticky: boolean;
}
const key = "gpt-view-cache-v1";
type Cache = {
  chats: Record<string, GptCachedChat>;
  jobs: GptJob[];
  items: GptConversation[];
  projects: GptProject[];
  models: GptModels | null;
  catalogAt: number;
  projectsAt: number;
  model: string;
  effort: string;
  offset: number | null;
  stamps: Record<string, number>;
};
const empty = (): Cache => ({
  chats: {},
  jobs: [],
  items: [],
  projects: [],
  models: null,
  catalogAt: 0,
  projectsAt: 0,
  model: "",
  effort: "",
  offset: null,
  stamps: {},
});
function restore(): Cache {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) ?? "null");
    if (value?.version === 1 && value.expires > Date.now() && value.data?.chats)
      return { ...empty(), ...value.data, stamps: {} };
  } catch {}
  return empty();
}
export const gptCache = restore();
let epoch = 0;
const historyRequests = new Map<string, number>();
let requestSerial = 0;
export function beginGptHistory(id: string) {
  const serial = ++requestSerial;
  historyRequests.set(id, serial);
  return serial;
}
export function currentGptHistory(id: string, serial: number) {
  return historyRequests.get(id) === serial;
}
export const gptCacheEpoch = () => epoch;
let timer: ReturnType<typeof setTimeout> | undefined;
export function saveGptCache() {
  clearTimeout(timer);
  timer = setTimeout(flushGptCache, 200);
}
export function flushGptCache() {
  clearTimeout(timer);
  // Bound both the in-memory LRU and the optional same-tab reload cache.
  const entries = Object.entries(gptCache.chats).sort((a, b) => b[1].checkedAt - a[1].checkedAt);
  let budget = 0;
  gptCache.chats = Object.fromEntries(
    entries.filter(([_, value], index) => {
      budget += JSON.stringify(value).length * 2;
      return index < 8 && budget < 6 * 1024 ** 2;
    }),
  );
  try {
    // Oversized outbox answers or one older chat must not erase every reload snapshot.
    const saved = { ...gptCache, jobs: gptCache.jobs.slice(0, 10), chats: { ...gptCache.chats } };
    const encode = () =>
      JSON.stringify({ version: 1, expires: Date.now() + 30 * 60000, data: saved });
    let data = encode();
    if (data.length >= 1800000) {
      saved.jobs = [];
      data = encode();
    }
    const oldest = Object.entries(saved.chats).sort((a, b) => a[1].checkedAt - b[1].checkedAt);
    while (data.length >= 1800000 && oldest.length) {
      delete saved.chats[oldest.shift()![0]];
      data = encode();
    }
    if (data.length < 1800000) sessionStorage.setItem(key, data);
  } catch {
    // Safari storage may be unavailable; memory retention still works.
  }
}
export function clearGptCache() {
  epoch++;
  historyRequests.clear();
  clearTimeout(timer);
  Object.assign(gptCache, empty());
  try {
    sessionStorage.removeItem(key);
  } catch {}
}
if (typeof window !== "undefined") {
  window.addEventListener("private-session-ended", clearGptCache);
  window.addEventListener("pagehide", flushGptCache);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) flushGptCache();
  });
}
