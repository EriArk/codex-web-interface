import { HubError } from "@codex-web/shared";

/** Account-wide history cooldown. Never used to retry writes or to confirm a stale read. */
export class GptReadBackoff {
  private until = 0;
  private failures = 0;
  private limited = false;
  constructor(private now = Date.now) {}
  check() {
    if (this.now() < this.until) throw this.error();
  }
  success() {
    // A read already in flight must not cancel another read's new cooldown.
    if (this.now() >= this.until) this.failures = 0;
  }
  fail(status: number, retryAfter: string | null) {
    this.failures = Math.min(this.failures + 1, 5);
    this.limited = status === 429;
    const now = this.now();
    const seconds = retryAfter?.trim();
    const requested = seconds
      ? /^\d+(?:\.\d+)?$/.test(seconds)
        ? Number(seconds) * 1000
        : Date.parse(seconds) - now
      : 0;
    const delay = Math.max(
      Math.min((this.limited ? 60000 : 15000) * 2 ** (this.failures - 1), 300000),
      Number.isFinite(requested) ? Math.max(0, Math.min(requested, 86400000)) : 0,
    );
    this.until = Math.max(this.until, now + delay);
    return this.error();
  }
  private error() {
    return new HubError(
      this.limited ? 429 : 503,
      this.limited ? "GPT_HISTORY_RATE_LIMITED" : "GPT_HISTORY_UNAVAILABLE",
      this.limited
        ? "ChatGPT временно ограничил обновление истории. Повторим автоматически после паузы."
        : "Не удалось обновить историю ChatGPT. Повторим автоматически; показанные сообщения сохранены.",
    );
  }
}
