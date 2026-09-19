import { gptFileLimit, UPLOAD_CHUNK_BYTES } from "@codex-web/shared";
import { ApiError, api } from "./api";

const active = new Set<AbortController>();
let pending = new WeakMap<File, Map<string, string>>();
if (typeof window !== "undefined")
  window.addEventListener("private-session-ended", () => {
    for (const c of active) c.abort();
    active.clear();
    pending = new WeakMap();
  });
/** File slices keep the phone's JS memory bounded. Retry the same offset and ID only. */
export async function uploadFile<T>(
  file: File,
  target: { kind: "codex" | "gpt"; threadId?: string },
  progress?: (bytes: number, total: number) => void,
): Promise<{ file: T; sha256: string }> {
  if (!file.size) throw Error("Пустой файл нельзя прикрепить.");
  if (target.kind === "gpt" && file.size > gptFileLimit(file.name))
    throw Error(
      `Предел ChatGPT для файла «${file.name}» — ${gptFileLimit(file.name) / 1024 ** 2} МБ.`,
    );
  const controller = new AbortController();
  active.add(controller);
  try {
    const scope = JSON.stringify(target),
      cached = pending.get(file) ?? new Map<string, string>();
    pending.set(file, cached);
    const id = cached.get(scope) ?? crypto.randomUUID();
    cached.set(scope, id);
    const path = `/upload-transfers/${id}`;
    type State = {
      offset: number;
      bytes: number;
      chunkBytes: number;
      result: { file: T; sha256: string } | null;
    };
    const retry = async <R>(action: () => Promise<R>): Promise<R> => {
      try {
        return await action();
      } catch (e) {
        if (!(e instanceof ApiError) || (e.status !== 0 && e.status !== 429 && e.status < 500))
          throw e;
        if (e.status === 429)
          await new Promise<void>((resolve, reject) => {
            const done = () => {
              controller.signal.removeEventListener("abort", abort);
              resolve();
            };
            const timer = setTimeout(done, 60000);
            const abort = () => {
              clearTimeout(timer);
              reject(new DOMException("Aborted", "AbortError"));
            };
            controller.signal.addEventListener("abort", abort, { once: true });
            if (controller.signal.aborted) abort();
          });
        // One bounded retry, same idempotent request. This never resubmits a chat message.
        return action();
      }
    };
    let state = await retry(() =>
      api<State>(path, {
        signal: controller.signal,
        method: "POST",
        body: { ...target, name: file.name, bytes: file.size },
      }),
    );
    if (state.result) {
      cached.delete(scope);
      return state.result;
    }
    if (state.bytes !== file.size || state.offset < 0 || state.offset > file.size)
      throw Error("Состояние загрузки изменилось.");
    progress?.(state.offset, file.size);
    while (state.offset < file.size) {
      const offset = state.offset,
        end = Math.min(file.size, offset + UPLOAD_CHUNK_BYTES);
      state = await retry(() =>
        api<State>(`${path}?offset=${offset}`, {
          signal: controller.signal,
          method: "PUT",
          raw: file.slice(offset, end),
        }),
      );
      if (state.offset !== end)
        throw Error("Не удалось подтвердить фрагмент файла. Повтори загрузку.");
      progress?.(end, file.size);
    }
    const result = await retry(() =>
      api<{ file: T; sha256: string }>(path + "/complete", {
        signal: controller.signal,
        method: "POST",
        body: {},
      }),
    );
    cached.delete(scope);
    return result;
  } finally {
    active.delete(controller);
  }
}
