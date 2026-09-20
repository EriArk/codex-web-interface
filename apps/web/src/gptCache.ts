import type { GptConversation, GptJob, GptMessage, GptModels, GptProject } from "@codex-web/shared";
import {
  accountSessionStorage as sessionStorage,
  accountLocalStorage as localStorage,
} from "./accountStorage.ts";

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
const navigationKey = "gpt-navigation-cache-v1";
const modelsKey = "gpt-models-cache-v1";
function restoreModels() {
  try {
    const raw = localStorage.getItem(modelsKey);
    if (!raw || raw.length > 64000) return {};
    const value = JSON.parse(raw);
    const choices = (rows: unknown): boolean =>
      Array.isArray(rows) &&
      rows.length <= 100 &&
      rows.every((row) => row && typeof row.id === "string" && typeof row.label === "string");
    const models = value.models;
    if (
      value.version !== 1 ||
      !models ||
      !choices(models.models) ||
      !models.models.length ||
      !choices(models.efforts) ||
      typeof models.currentModel !== "string" ||
      typeof models.currentEffort !== "string" ||
      typeof value.model !== "string" ||
      typeof value.effort !== "string" ||
      (models.effortsByModel &&
        (typeof models.effortsByModel !== "object" ||
          !Object.values(models.effortsByModel).every(choices)))
    )
      return {};
    return { models: models as GptModels, model: value.model, effort: value.effort };
  } catch {
    return {};
  }
}
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
      return {
        ...empty(),
        ...value.data,
        ...(!value.data.models ? restoreModels() : {}),
        stamps: {},
      };
  } catch {}
  const cache = { ...empty(), ...restoreModels() };
  try {
    const value = JSON.parse(localStorage.getItem(navigationKey) ?? "null");
    if (
      value?.version === 1 &&
      value.expires > Date.now() &&
      Array.isArray(value.items) &&
      Array.isArray(value.projects) &&
      value.items.every(
        (row: GptConversation) =>
          row && typeof row.id === "string" && typeof row.title === "string",
      ) &&
      value.projects.every(
        (row: GptProject) => row && typeof row.id === "string" && typeof row.name === "string",
      )
    ) {
      cache.items = value.items;
      cache.projects = value.projects;
      cache.offset = Number.isSafeInteger(value.offset) && value.offset >= 0 ? value.offset : null;
    }
  } catch {}
  return cache;
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
  // Only selectable metadata survives tab eviction; connection readiness is always live.
  try {
    if (gptCache.models) {
      const data = JSON.stringify({
        version: 1,
        models: gptCache.models,
        model: gptCache.model,
        effort: gptCache.effort,
      });
      if (data.length <= 64000) localStorage.setItem(modelsKey, data);
    }
  } catch {}
  // Navigation survives PWA tab eviction; history, readiness and credentials do not.
  try {
    const data = JSON.stringify({
      version: 1,
      expires: Date.now() + 7 * 86400000,
      items: gptCache.items,
      projects: gptCache.projects,
      offset: gptCache.offset,
    });
    if (data.length < 500000) localStorage.setItem(navigationKey, data);
  } catch {}
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
    localStorage.removeItem(navigationKey);
    localStorage.removeItem(modelsKey);
  } catch {}
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
