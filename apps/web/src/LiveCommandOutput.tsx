import type { NativeCommand } from "@codex-web/shared";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, messageOf } from "./api";
import { CopyButton } from "./CopyButton";
import { DownloadLink } from "./DownloadLink";

export function LiveCommandOutput({ url }: { url: string }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState<(NativeCommand & { available: boolean }) | null>(null);
  const [error, setError] = useState("");
  const output = useRef<HTMLPreElement>(null),
    follow = useRef(true);
  useEffect(() => {
    setValue(null);
    setError("");
    follow.current = true;
    if (!open) return;
    const controller = new AbortController();
    let pending = false;
    const refresh = async () => {
      if (pending || document.visibilityState === "hidden") return;
      pending = true;
      try {
        const next = await api<NativeCommand & { available: boolean }>(url.replace(/^\/api/, ""), {
          signal: controller.signal,
        });
        if (!controller.signal.aborted) {
          setValue(next);
          setError("");
        }
      } catch (e) {
        if (!controller.signal.aborted) setError(messageOf(e));
      } finally {
        pending = false;
      }
    };
    void refresh();
    const timer = setInterval(refresh, 1200);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      controller.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [url, open]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Follow new rendered output, without moving an owner who scrolled away.
  useLayoutEffect(() => {
    if (follow.current && output.current) output.current.scrollTop = output.current.scrollHeight;
  }, [value]);
  return (
    <details
      className="code-disclosure command-output"
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>Ответ терминала</summary>
      {error && <p role="status">{error}</p>}
      {!value && !error && <p>Загружаем вывод…</p>}
      {value?.available && (
        <>
          <pre
            ref={output}
            onScroll={(e) => {
              const el = e.currentTarget;
              follow.current = el.scrollHeight - el.clientHeight - el.scrollTop < 24;
            }}
          >
            {value.text ||
              (value.status === "inProgress" ? "Ожидаем вывод…" : "Без текстового вывода")}
          </pre>
          {value.truncated && <small>Показан конец сохранённого лога.</small>}
          <div className="command-log-actions">
            <CopyButton text={value.text} label="Копировать вывод" />
            <DownloadLink href={url + "&download=1"} name="command-output.txt">
              Скачать лог
            </DownloadLink>
          </div>
        </>
      )}
      {value && !value.available && <p>Вывод этой команды не сохранён.</p>}
    </details>
  );
}
