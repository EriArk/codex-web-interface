import type {
  ResetCredit,
  ResetCredits,
  UsageGroup,
  UsageLimitsData,
  UsageWindow,
} from "@codex-web/shared";

const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const timestamp = (v: unknown) =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= 253402300799 ? v : null;
// biome-ignore lint/suspicious/noControlCharactersInRegex: Strip native display control and bidi characters.
const displayControls = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: Reject control characters without rewriting opaque identifiers.
const idControls = /[\u0000-\u001f\u007f]/;
const display = (v: unknown, max: number) =>
  typeof v === "string" ? v.replace(displayControls, " ").trim().slice(0, max) || null : null;
export function normalizeResetCredits(value: unknown): ResetCredits | null {
  const raw = record(value);
  if (
    !Number.isSafeInteger(raw.availableCount) ||
    Number(raw.availableCount) < 0 ||
    Number(raw.availableCount) > 1000000
  )
    return null;
  const credits: ResetCredit[] = [];
  if (Array.isArray(raw.credits))
    for (const candidate of raw.credits.slice(0, 64)) {
      const c = record(candidate);
      // Never truncate or rewrite an opaque identifier, including whitespace.
      if (
        typeof c.id !== "string" ||
        !c.id.trim() ||
        c.id.length > 1024 ||
        idControls.test(c.id) ||
        credits.some((v) => v.id === c.id)
      )
        continue;
      const expiry = c.expiresAt == null ? null : timestamp(c.expiresAt);
      credits.push({
        id: c.id,
        resetType: c.resetType === "codexRateLimits" ? c.resetType : "unknown",
        status:
          ["available", "redeeming", "redeemed"].includes(String(c.status)) &&
          (c.expiresAt == null || expiry !== null)
            ? (c.status as ResetCredit["status"])
            : "unknown",
        grantedAt: timestamp(c.grantedAt),
        expiresAt: expiry,
        title: display(c.title, 160),
        description: display(c.description, 500),
      });
    }
  return {
    availableCount: Number(raw.availableCount),
    credits: raw.credits == null ? null : credits,
  };
}
export function normalizeLimits(value: unknown): UsageLimitsData {
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
  return {
    available: groups.length > 0,
    groups,
    resetCredits: normalizeResetCredits(response.rateLimitResetCredits),
    checkedAt: new Date().toISOString(),
  };
}
