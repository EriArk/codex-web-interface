export interface UsageWindow {
  minutes: number;
  remainingPercent: number;
  resetsAt: number | null;
}
export interface UsageGroup {
  id: string;
  name: string;
  windows: UsageWindow[];
}
const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
export function normalizeLimits(value: unknown): {
  available: boolean;
  groups: UsageGroup[];
  checkedAt: string;
} {
  const response = record(value),
    byId = record(response.rateLimitsByLimitId),
    groups: UsageGroup[] = [];
  const fallback = record(response.rateLimits);
  const sources = Object.keys(byId).length
    ? Object.entries(byId)
    : Object.keys(fallback).length
      ? [[String(fallback.limitId || "codex"), fallback]]
      : [];
  for (const [key, raw] of sources.slice(0, 16)) {
    const limit = record(raw),
      windows: UsageWindow[] = [];
    for (const candidate of [limit.primary, limit.secondary]) {
      const v = record(candidate),
        minutes = v.windowDurationMins,
        used = v.usedPercent,
        reset = v.resetsAt;
      if (
        typeof minutes !== "number" ||
        !Number.isInteger(minutes) ||
        minutes <= 0 ||
        minutes > 525600 ||
        typeof used !== "number" ||
        !Number.isFinite(used)
      )
        continue;
      windows.push({
        minutes,
        remainingPercent: Math.max(0, Math.min(100, Math.round(100 - used))),
        resetsAt:
          typeof reset === "number" && Number.isFinite(reset) && reset >= 0 && reset < 8640000000000
            ? reset
            : null,
      });
    }
    if (windows.length)
      groups.push({
        id: String(key).slice(0, 100),
        name:
          typeof limit.limitName === "string" && limit.limitName
            ? limit.limitName.slice(0, 120)
            : String(key) === "codex"
              ? "Codex"
              : "Дополнительный лимит",
        windows: windows.sort((a, b) => b.minutes - a.minutes),
      });
  }
  groups.sort((a, b) =>
    a.id === "codex" ? -1 : b.id === "codex" ? 1 : a.name.localeCompare(b.name),
  );
  return { available: groups.length > 0, groups, checkedAt: new Date().toISOString() };
}
