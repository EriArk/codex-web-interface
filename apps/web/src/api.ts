import type { Session } from "./types";

let csrf = "";
let sessionRevision = 0;
let sessionRotation: Promise<void> | undefined;
let unauthorized = () => {};
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export function configureApi(token: string, onUnauthorized: () => void): void {
  csrf = token;
  sessionRevision++;
  unauthorized = onUnauthorized;
}
type ApiOptions = {
  method?: string;
  body?: unknown;
  key?: string;
  signal?: AbortSignal;
  raw?: Blob;
  timeoutMs?: number;
};
export async function api<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const controller = new AbortController();
  const write = !!options.method && options.method !== "GET";
  const timeout = options.timeoutMs ?? (options.raw ? 180000 : write ? 135000 : 30000);
  let expired = false;
  const abort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  let rejectAbort: () => void = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    rejectAbort = () =>
      reject(controller.signal.reason ?? new DOMException("Aborted", "AbortError"));
    if (controller.signal.aborted) rejectAbort();
    else controller.signal.addEventListener("abort", rejectAbort, { once: true });
  });
  const timer = setTimeout(() => {
    expired = true;
    controller.abort(new DOMException("Request timed out", "TimeoutError"));
  }, timeout);
  try {
    return await Promise.race([
      request<T>(path, { ...options, signal: controller.signal }),
      cancelled,
    ]);
  } catch (error) {
    if (expired)
      throw new ApiError(
        0,
        "REQUEST_TIMEOUT",
        write
          ? "Сервер не подтвердил действие вовремя. Черновик сохранён; проверь состояние перед повтором."
          : "Сервер долго не отвечает. Повторяем подключение.",
      );
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    controller.signal.removeEventListener("abort", rejectAbort);
  }
}
async function request<T>(
  path: string,
  options: { method?: string; body?: unknown; key?: string; signal?: AbortSignal; raw?: Blob } = {},
): Promise<T> {
  if (sessionRotation && path !== "/auth/password") await sessionRotation;
  const requestSession = sessionRevision;
  const headers: Record<string, string> = {};
  if (options.raw) headers["Content-Type"] = "application/octet-stream";
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.method && options.method !== "GET") headers["X-CSRF-Token"] = csrf;
  if (options.key) headers["Idempotency-Key"] = options.key;
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method: options.method ?? "GET",
      headers,
      body: options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
      credentials: "same-origin",
      cache: "no-store",
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ApiError(0, "OFFLINE", "Нет связи с сервером. Проверь подключение.");
  }
  if (response.status === 401 && sessionRotation && path !== "/auth/password")
    await sessionRotation;
  if (response.status === 401 && path !== "/auth/login" && requestSession === sessionRevision) {
    if (typeof window !== "undefined") window.dispatchEvent(new Event("private-session-ended"));
    unauthorized();
  }
  if (response.ok && (path === "/auth/logout" || path === "/auth/logout-all"))
    if (typeof window !== "undefined") window.dispatchEvent(new Event("private-session-ended"));
  let value: { error?: { code?: string; message?: string } };
  try {
    value = await response.json();
    if (!value || typeof value !== "object") throw new Error("Unexpected response shape");
  } catch {
    throw new ApiError(
      response.status,
      "INVALID_RESPONSE",
      options.method && options.method !== "GET"
        ? response.status >= 500
          ? "Сервер не подтвердил действие. Черновик сохранён. Проверь связь и состояние диалога."
          : "Не удалось прочитать ответ сервера. Обнови страницу; черновик сохранён."
        : "Не удалось получить данные от сервера. Попробуй ещё раз.",
    );
  }
  if (!response.ok) {
    throw new ApiError(
      response.status,
      value.error?.code ?? "REQUEST_FAILED",
      value.error?.message ?? "Не удалось выполнить действие",
    );
  }
  return value as T;
}
export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : "Не удалось выполнить действие";

export async function changePassword(
  currentPassword: string,
  password: string,
  onSession: (session: Session) => void,
) {
  if (sessionRotation) throw new ApiError(409, "PASSWORD_CHANGE_BUSY", "Пароль уже сохраняется");
  let release = () => {};
  sessionRotation = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const session = await api<Session>("/auth/password", {
      method: "POST",
      body: { currentPassword, password },
    });
    onSession(session);
  } finally {
    sessionRotation = undefined;
    release();
  }
}
