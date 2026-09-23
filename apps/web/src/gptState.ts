import type { GptHistoryPage, GptJob, GptMessage } from "@codex-web/shared";
import type { GptCachedChat } from "./gptCache";
// The durable outbox's initial "queued" state is not a user-visible queue.
export function waitingGptJob(job: GptJob, jobs: GptJob[]): boolean {
  return (
    job.status === "queued" &&
    !!job.nativeId &&
    jobs.some(
      (other) =>
        other.id !== job.id &&
        !other.dismissed &&
        other.nativeId === job.nativeId &&
        other.createdAt <= job.createdAt &&
        ["queued", "preparing", "running", "unknown"].includes(other.status),
    )
  );
}

// A failed pre-dispatch attempt can outlive an explicit successful retry.
// Hide only that obsolete presentation; do not mutate receipts or resolve unknown sends.
export function completedGptRetry(job: GptJob, jobs: GptJob[]): boolean {
  if (job.status !== "failed" || !job.nativeId || job.summaryOnly) return false;
  return jobs.some(
    (next) =>
      next.id !== job.id &&
      !next.dismissed &&
      !next.summaryOnly &&
      next.status === "completed" &&
      next.nativeId === job.nativeId &&
      next.createdAt >= job.updatedAt &&
      next.createdAt <= job.updatedAt + 300000 &&
      next.text === job.text &&
      next.files.length === job.files.length &&
      next.files.every((file, index) => file.id === job.files[index]?.id),
  );
}

export function showGptJob(
  job: GptJob,
  messages: GptMessage[],
  now = Date.now(),
  jobs: GptJob[] = [],
  historyUnavailable = false,
): boolean {
  // Catalog summaries carry status only: their empty strings are not message content.
  if (job.summaryOnly || job.dismissed || completedGptRetry(job, jobs)) return false;
  if (["queued", "preparing", "running", "failed", "unknown"].includes(job.status)) return true;
  if (job.status === "cancelled" && !job.answer && !job.assets.length) return false;
  // Completed outbox entries must never append old messages below a paged native history.
  if (!historyUnavailable && job.updatedAt < now - 120000) return false;
  if (
    historyUnavailable &&
    job.updatedAt < now - 120000 &&
    jobs.some(
      (next) =>
        next.nativeId === job.nativeId &&
        !next.summaryOnly &&
        !next.dismissed &&
        next.status === "completed" &&
        next.createdAt > job.createdAt,
    )
  )
    return false;
  const user = messages.findIndex(
    (message) =>
      message.role === "user" &&
      message.text === job.text &&
      message.createdAt * 1000 >= job.createdAt - 30000 &&
      message.createdAt * 1000 <= job.updatedAt,
  );
  if (user >= 0) {
    const later = messages.slice(user + 1);
    const nextUser = later.findIndex((message) => message.role === "user");
    const turn = nextUser < 0 ? later : later.slice(0, nextUser);
    if (
      turn.some(
        (message) =>
          message.role === "assistant" &&
          message.phase !== "commentary" &&
          message.complete !== false,
      )
    )
      return false;
    if (nextUser >= 0) return false;
  } else if (messages.some((message) => message.createdAt * 1000 > job.createdAt + 1000))
    return false;
  return true;
}

export function mergeGptJobs(previous: GptJob[], incoming: GptJob[]): GptJob[] {
  if (!incoming.length) return previous;
  const map = new Map(previous.map((job) => [job.id, job]));
  for (const job of incoming) {
    const old = map.get(job.id);
    // A response already in flight must not resurrect an explicitly deleted outbox item.
    if (old?.dismissed && !job.dismissed) continue;
    if (old && old.updatedAt > job.updatedAt) continue;
    map.set(
      job.id,
      job.dismissed
        ? { ...job, text: "", files: [], answer: "", assets: [], progress: [], error: "" }
        : job.summaryOnly && old && !old.summaryOnly
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
  if (page.delta) {
    const delta = page.delta;
    if (!previous || previous.revision !== delta.baseRevision)
      throw Error("GPT_HISTORY_DELTA_MISMATCH");
    const replaced =
      delta.replaceFrom === null
        ? -1
        : previous.messages.findIndex((m) => m.id === delta.replaceFrom);
    const after =
      delta.after === null ? -1 : previous.messages.findIndex((m) => m.id === delta.after);
    const cut =
      replaced >= 0
        ? replaced
        : after >= 0
          ? after + 1
          : !previous.messages.length && delta.after === null
            ? 0
            : -1;
    if (cut < 0) throw Error("GPT_HISTORY_DELTA_MISMATCH");
    const messages = [...previous.messages.slice(0, cut), ...page.items];
    return {
      ...previous,
      messages,
      revision: page.revision,
      checkedAt: Date.now(),
      stale: page.stale,
      refreshMessage: page.refreshMessage,
    };
  }
  if (page.notModified && previous)
    return {
      ...previous,
      checkedAt: Date.now(),
      stale: page.stale,
      refreshMessage: page.refreshMessage,
    };
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
    stale: page.stale,
    refreshMessage: page.refreshMessage,
    messages,
    contextMessage: older ? previous?.contextMessage : page.contextMessage,
    hasNewer: older ? previous?.hasNewer : page.hasNewer,
    before: older ? page.nextBefore : retained ? previous!.before : page.nextBefore,
    revision: older && previous ? previous.revision : page.revision,
    prefix: older && previous ? previous.prefix : page.prefix,
    anchor: older && previous ? previous.anchor : (page.items[0]?.id ?? ""),
    checkedAt: older && previous ? previous.checkedAt : Date.now(),
    scrollTop: previous?.scrollTop ?? 0,
    sticky: previous?.sticky ?? true,
  };
}
