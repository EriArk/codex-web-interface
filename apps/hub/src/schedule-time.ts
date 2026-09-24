import type { CodexScheduleRule } from "@codex-web/shared";
import { HubError } from "@codex-web/shared";

const invalid = () =>
  new HubError(
    400,
    "SCHEDULE_TIME",
    "Проверь дату, время и часовой пояс. Несуществующее при переводе часов время выбери заново.",
  );
function formatter(zone: string) {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    throw invalid();
  }
}
function wall(fmt: Intl.DateTimeFormat, instant: number) {
  const p = Object.fromEntries(fmt.formatToParts(instant).map((p) => [p.type, p.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
/** A fold runs once at its first instant. A recurring gap skips that calendar day. */
export function scheduleInstant(date: string, time: string, zone: string): number | null {
  const fmt = formatter(zone),
    local = `${date}T${time}`,
    naive = Date.parse(local + ":00Z");
  if (!Number.isFinite(naive) || new Date(naive).toISOString().slice(0, 16) !== local)
    throw invalid();
  const offsets = new Set<number>();
  for (let h = -36; h <= 36; h += 6) {
    const t = naive + h * 3600000;
    offsets.add(Date.parse(wall(fmt, t) + ":00Z") - t);
  }
  const candidates = [...offsets].map((o) => naive - o).filter((t) => wall(fmt, t) === local);
  return candidates.length ? Math.min(...candidates) : null;
}
export function nextScheduleTime(rule: CodexScheduleRule, after: number): number | null {
  const first = scheduleInstant(rule.date, rule.time, rule.timezone);
  if (!rule.weekdays.length) {
    if (first === null) throw invalid();
    return first > after ? first : null;
  }
  const today = wall(formatter(rule.timezone), after).slice(0, 10);
  const start = Date.parse((today > rule.date ? today : rule.date) + "T12:00:00Z");
  for (let d = 0; d < 15; d++) {
    const day = new Date(start + d * 86400000);
    if (!rule.weekdays.includes(day.getUTCDay())) continue;
    const instant = scheduleInstant(day.toISOString().slice(0, 10), rule.time, rule.timezone);
    if (instant !== null && instant > after) return instant;
  }
  throw invalid();
}
