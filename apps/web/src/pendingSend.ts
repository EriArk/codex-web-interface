// The receipt lives exactly as long as the same-tab draft, including reloads and mode switches.
const prefix = "codex-pending-send:";
type Receipt = { signature: string; key: string };
export function pendingSendKey(scope: string, signature: string): string {
  try {
    const saved = JSON.parse(sessionStorage.getItem(prefix + scope) ?? "null") as Receipt | null;
    if (saved?.signature === signature && /^[0-9a-f-]{36}$/.test(saved.key)) return saved.key;
    const key = crypto.randomUUID();
    sessionStorage.setItem(prefix + scope, JSON.stringify({ signature, key }));
    return key;
  } catch {
    // Never send a new operation if its reload-safe receipt could not be saved.
    throw new Error(
      "Не удалось сохранить отправку на устройстве. Черновик сохранён; освободи место и повтори.",
    );
  }
}
export function matchesPendingSend(scope: string, signature: string): boolean {
  try {
    return JSON.parse(sessionStorage.getItem(prefix + scope) ?? "null")?.signature === signature;
  } catch {
    return false;
  }
}
export function completePendingSend(scope: string, key: string): void {
  try {
    const saved = JSON.parse(sessionStorage.getItem(prefix + scope) ?? "null");
    if (saved?.key === key)
      sessionStorage.setItem(prefix + scope, JSON.stringify({ ...saved, acknowledged: true }));
  } catch {}
}
// Clear only after the composer has persisted the new/empty draft, avoiding an ACK/reload gap.
export function clearAcknowledgedSend(scope: string): void {
  try {
    if (JSON.parse(sessionStorage.getItem(prefix + scope) ?? "null")?.acknowledged)
      sessionStorage.removeItem(prefix + scope);
  } catch {}
}
if (typeof window !== "undefined")
  window.addEventListener("private-session-ended", () => {
    try {
      for (const key of Object.keys(sessionStorage))
        if (key.startsWith(prefix)) sessionStorage.removeItem(key);
    } catch {}
  });
