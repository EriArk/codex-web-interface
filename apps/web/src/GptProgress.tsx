import type { GptProgress as Progress } from "@codex-web/shared";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "./icons";

export function GptProgress({
  items,
  running = false,
  label,
  onStop,
  live,
}: {
  items: Progress[];
  running?: boolean;
  label?: string;
  onStop?: () => void;
  live?: Progress[];
}) {
  const [open, setOpen] = useState(false);
  const ticker = useRef<HTMLSpanElement>(null);
  const details = useRef<HTMLElement>(null);
  const following = useRef(true);
  const visible = live?.length
    ? [...new Map([...items, ...live].map((item) => [item.id, item])).values()]
    : items;
  const latest = [...visible].reverse().find((item) => item.state === "active") ?? visible.at(-1);
  const text = running ? (latest?.text ?? label ?? "GPT работает") : "Этапы ответа";
  useLayoutEffect(() => {
    if (ticker.current && live?.length) ticker.current.scrollLeft = ticker.current.scrollWidth;
    if (details.current && following.current)
      details.current.scrollTop = details.current.scrollHeight;
  }, [text, live, open]);
  useEffect(() => {
    if (!running) setOpen(false);
  }, [running]);
  return (
    <section className="gpt-progress-panel">
      <div className="gpt-progress">
        <button
          type="button"
          className="gpt-progress-toggle"
          aria-expanded={open}
          aria-label={running ? "Ход ответа GPT" : "Этапы ответа"}
          onClick={() => {
            following.current = true;
            setOpen((value) => !value);
          }}
        >
          {running ? <span className="spinner" /> : <Icon name="check" size={16} />}
          <span ref={ticker} className={live?.length ? "gpt-live-ticker" : undefined}>
            <span>{live?.length ? text.slice(-600).replace(/\s+/g, " ") : text}</span>
          </span>
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
        <section
          ref={details}
          className="gpt-progress-details"
          aria-label="Этапы GPT"
          onScroll={(event) => {
            const node = event.currentTarget;
            following.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24;
          }}
        >
          {visible.length ? (
            <ol>
              {visible.map((item) => (
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
