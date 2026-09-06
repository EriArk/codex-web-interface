import type { GptJob, GptMessage } from "@codex-web/shared";
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
