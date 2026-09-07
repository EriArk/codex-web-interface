export const releaseId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export function readRelease(value: unknown): string | null {
  return value && typeof value === "object" && "id" in value && releaseId(value.id)
    ? value.id
    : null;
}
const pendingKey = "codex-pending-update";
export function rememberUpdate(id: string) {
  try {
    sessionStorage.setItem(pendingKey, JSON.stringify({ id, expires: Date.now() + 10 * 60000 }));
  } catch {}
}
export function pendingUpdate(): string | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(pendingKey) ?? "null");
    if (value?.expires > Date.now() && releaseId(value.id)) return value.id;
    sessionStorage.removeItem(pendingKey);
  } catch {}
  return null;
}
export function clearUpdate() {
  try {
    sessionStorage.removeItem(pendingKey);
  } catch {}
}
export function updateUrl(href: string, id: string) {
  const url = new URL(href);
  url.searchParams.set("_codex_update", id);
  return url.href;
}
