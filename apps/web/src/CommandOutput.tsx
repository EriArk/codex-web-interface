import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { CopyButton } from "./CopyButton";

type Output = { available: boolean; text: string | null; truncated: boolean };
export function CommandOutput({ threadId, resultId }: { threadId: string; resultId: string }) {
  const [output, setOutput] = useState<Output | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      request.current?.abort();
    },
    [],
  );
  const load = async () => {
    if (request.current || output) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError(false);
    try {
      const value = await api<Output>(
        `/threads/${encodeURIComponent(threadId)}/results/${encodeURIComponent(resultId)}/output`,
        { signal: controller.signal, timeoutMs: 15000 },
      );
      if (!controller.signal.aborted) setOutput(value);
    } catch {
      if (!controller.signal.aborted) setError(true);
    } finally {
      if (!controller.signal.aborted) setBusy(false);
      if (request.current === controller) request.current = null;
    }
  };
  return (
    <div className="copyable-block">
      <details
        className="code-disclosure command-output"
        onToggle={(event) => {
          if (event.currentTarget.open) void load();
        }}
      >
        <summary>Ответ терминала</summary>
        {busy && <p role="status">Загружаем вывод…</p>}
        {error && (
          <button type="button" className="secondary" onClick={() => void load()}>
            Повторить загрузку
          </button>
        )}
        {output &&
          (output.available ? (
            <>
              {output.text ? <pre>{output.text}</pre> : <p>Команда не вывела текст.</p>}
              {output.truncated && <small>Сохранена первая часть вывода.</small>}
            </>
          ) : (
            <p>Вывод этой команды не сохранён.</p>
          ))}
      </details>
      {output?.available && output.text && (
        <CopyButton text={output.text} label="Копировать ответ терминала" />
      )}
    </div>
  );
}
