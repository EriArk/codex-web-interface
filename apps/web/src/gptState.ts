import type { GptHistoryPage, GptJob, GptMessage } from "@codex-web/shared";
import type { GptCachedChat } from "./gptCache";
export function showGptJob(job: GptJob, messages: GptMessage[], now = Date.now()): boolean {
  if (["queued", "preparing", "running", "failed", "unknown"].includes(job.status)) return true;
  if (job.status === "cancelled" && !job.answer && !job.assets.length) return false;
  // Completed outbox entries must never append old messages below a paged native history.
  if (job.updatedAt < now - 120000) return false;
  const user = messages.findIndex(
    (message) =>
      message.role === "user" &&
      message.text === job.text &&
      message.createdAt * 1000 >= job.createdAt - 30000,
  );
  if (user >= 0) {
    const later = messages.slice(user + 1);
    if (later.some((message) => message.role === "assistant")) return false;
  } else if (messages.some((message) => message.createdAt * 1000 > job.createdAt + 1000))
    return false;
  return true;
}

export function mergeGptJobs(previous: GptJob[], incoming: GptJob[]): GptJob[] {
  const map = new Map(previous.map((job) => [job.id, job]));
  for (const job of incoming) {
    const old = map.get(job.id);
    if (old && old.updatedAt > job.updatedAt) continue;
    map.set(
      job.id,
      job.summaryOnly && old && !old.summaryOnly
        ? { ...old, status: job.status, nativeId: job.nativeId, updatedAt: job.updatedAt }
        : job,
    );
  }
  return [...map.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 100);
}

export function mergeGptHistory(
  previous: GptCachedChat | undefined,
  page: GptHistoryPage,
  older = false,
): GptCachedChat {
  if (page.notModified && previous) return { ...previous, checkedAt: Date.now() };
  const keep = !!previous && (older || page.retainOlder);
  let messages = page.items;
  if (keep && previous) {
    if (older)
      messages = [...new Map([...page.items, ...previous.messages].map((m) => [m.id, m])).values()];
    else {
      const overlap = previous.messages.findIndex((m) => m.id === page.items[0]?.id);
      if (overlap >= 0) messages = [...previous.messages.slice(0, overlap), ...page.items];
    }
  }
  const retained = keep && messages.length > page.items.length;
  return {
    messages,
    before: older ? page.nextBefore : retained ? previous!.before : page.nextBefore,
    revision: older && previous ? previous.revision : page.revision,
    prefix: older && previous ? previous.prefix : page.prefix,
    anchor: older && previous ? previous.anchor : (page.items[0]?.id ?? ""),
    checkedAt: older && previous ? previous.checkedAt : Date.now(),
    scrollTop: previous?.scrollTop ?? 0,
    sticky: previous?.sticky ?? true,
  };
}
