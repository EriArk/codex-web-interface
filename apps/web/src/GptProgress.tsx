import type { GptProgress as Progress } from "@codex-web/shared";
import { useEffect, useState } from "react";
import { Icon } from "./icons";

export function GptProgress({
  items,
  running = false,
  label,
  onStop,
}: {
  items: Progress[];
  running?: boolean;
  label?: string;
  onStop?: () => void;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!running) setOpen(false);
  }, [running]);
  const latest = [...items].reverse().find((item) => item.state === "active") ?? items.at(-1);
  return (
    <section className="gpt-progress-panel">
      <div className="gpt-progress">
        <button
          type="button"
          className="gpt-progress-toggle"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {running ? <span className="spinner" /> : <Icon name="check" size={16} />}
          <span>{running ? (latest?.text ?? label ?? "GPT работает") : "Этапы ответа"}</span>
          <Icon name="chevron" size={16} />
        </button>
        {onStop && (
          <button
            type="button"
            className="icon-button"
            aria-label="Остановить GPT"
            onClick={onStop}
          >
            <Icon name="stop" />
          </button>
        )}
      </div>
      {open && (
        <section className="gpt-progress-details" aria-label="Этапы GPT">
          {items.length ? (
            <ol>
              {items.map((item) => (
                <li key={item.id}>
                  <span>{item.text}</span>
                </li>
              ))}
            </ol>
          ) : (
            <p>{label ?? "GPT работает"}</p>
          )}
        </section>
      )}
    </section>
  );
}
