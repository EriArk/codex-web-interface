let csrf = "";
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
  unauthorized = onUnauthorized;
}
export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown; key?: string; signal?: AbortSignal; raw?: Blob } = {},
): Promise<T> {
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
  const value = await response.json();
  if (!response.ok) {
    if (response.status === 401 && path !== "/auth/login") unauthorized();
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
