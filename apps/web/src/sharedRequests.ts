import { useEffect, useRef, useState } from "react";
import { accountLocalStorage as storage } from "./accountStorage";
import { api, messageOf } from "./api";
export function useSharedAction() {
  const mounted = useRef(true),
    running = useRef(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const run = async <T>(work: () => Promise<T>): Promise<T | undefined> => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    try {
      const value = await work();
      return mounted.current ? value : undefined;
    } catch (error) {
      if (mounted.current) setError(messageOf(error));
    } finally {
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return { run, busy, error, setError, active: () => mounted.current };
}
/** Metadata retry receipts survive panel close, reload and network acknowledgement loss. */
export function sharedMutation<T>(path: string, method: string, body: unknown) {
  const signature = JSON.stringify({ method, body }),
    name = "workspace-shared-request:" + path;
  let key = crypto.randomUUID();
  try {
    const saved = JSON.parse(storage.getItem(name) ?? "null");
    if (saved?.signature === signature && typeof saved.key === "string") key = saved.key;
    else storage.setItem(name, JSON.stringify({ signature, key }));
  } catch {
    throw Error(
      "Не удалось сохранить подтверждение на устройстве. Освободи место и повтори действие.",
    );
  }
  return api<T>(path, { method, body, key });
}
