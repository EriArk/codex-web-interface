import type { Session } from "./types";

const hintKey = "codex-workspace-identity";
const valid = (value: string | null | undefined): value is string =>
  !!value && /^[a-f0-9-]{36}$/.test(value);
const hint = () => {
  try {
    const value = window.sessionStorage.getItem(hintKey);
    return valid(value) ? value : "";
  } catch {
    return "";
  }
};
// Immutable for the lifetime of this page: late callbacks keep their original storage namespace.
export const pageWorkspace = typeof window === "undefined" ? "" : hint();
const prefix = pageWorkspace ? `cw-user:${pageWorkspace}:` : "";
const ownedLegacy = (key: string) =>
  /^(codex[-:]|codexweb-|gpt[-:]|workspace-|native-|gui-preview-|delivery-draft:|quick-capture-|work-review-|file-(?:batch|archive|operation):)/.test(
    key,
  ) && key !== hintKey;

function scoped(kind: "localStorage" | "sessionStorage"): Storage {
  const storage = () => globalThis[kind];
  const keys = () =>
    Object.keys(storage())
      .filter((key) => (prefix ? key.startsWith(prefix) : ownedLegacy(key)))
      .map((key) => key.slice(prefix.length));
  const methods = {
    get length() {
      return keys().length;
    },
    key(index: number) {
      return keys()[index] ?? null;
    },
    getItem(key: string) {
      return storage().getItem(prefix + key);
    },
    setItem(key: string, value: string) {
      storage().setItem(prefix + key, value);
    },
    removeItem(key: string) {
      storage().removeItem(prefix + key);
    },
    clear() {
      for (const key of keys()) storage().removeItem(prefix + key);
    },
  };
  return new Proxy(methods, {
    ownKeys: keys,
    getOwnPropertyDescriptor: (_target, key) =>
      typeof key === "string" && keys().includes(key)
        ? { enumerable: true, configurable: true }
        : undefined,
  });
}
export const accountLocalStorage = scoped("localStorage");
export const accountSessionStorage = scoped("sessionStorage");

/** Return false while a full page replacement establishes a different account. */
export function admitWorkspace(session: Session): boolean {
  const next = session.team && valid(session.user?.id) ? session.user.id : "";
  if (next === pageWorkspace) return true;
  if (next && session.originalOwner) {
    for (const kind of ["localStorage", "sessionStorage"] as const) {
      const storage = window[kind],
        marker = `cw-user:${next}:legacy-migrated`;
      if (!storage.getItem(marker)) {
        for (const key of Object.keys(storage))
          if (ownedLegacy(key) && storage.getItem(`cw-user:${next}:${key}`) === null)
            storage.setItem(`cw-user:${next}:${key}`, storage.getItem(key)!);
        storage.setItem(marker, "true");
      }
    }
  }
  // Keep old callbacks in the old page until navigation; never retarget their draft writes.
  if (next) window.sessionStorage.setItem(hintKey, next);
  else window.sessionStorage.removeItem(hintKey);
  location.reload();
  return false;
}
export function workspaceUrl(input: string | URL) {
  if (!pageWorkspace) return input.toString();
  const url = new URL(input, location.href);
  if (pageWorkspace && url.host === location.host) url.searchParams.set("workspace", pageWorkspace);
  return url.toString();
}
export function workspaceMediaUrl(input: string | undefined) {
  return input ? workspaceUrl(input) : input;
}
export function workspaceSocket(input: string | URL) {
  return new WebSocket(workspaceUrl(input));
}
