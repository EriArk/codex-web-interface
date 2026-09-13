import { useEffect, useState } from "react";
import { api, messageOf } from "./api";

/** A changed path hides the previous record immediately; late requests cannot cross selections. */
export function useSharedResource<T>(
  path: string | null,
  revision = 0,
): { value?: T; error?: string; loading: boolean } {
  const [state, setState] = useState<{
    key: string;
    path: string | null;
    value?: T;
    error?: string;
  }>({ key: "", path: null });
  const key = path + ":" + revision;
  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    void api<T>(path, { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted) setState({ key, path, value });
      })
      .catch((error) => {
        if (!controller.signal.aborted) setState({ key, path, error: messageOf(error) });
      });
    return () => controller.abort();
  }, [path, key]);
  return state.path === path
    ? { value: state.value, error: state.error, loading: state.key !== key }
    : { loading: !!path };
}
