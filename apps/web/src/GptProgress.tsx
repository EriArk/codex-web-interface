import type { GptProgress as Progress } from "@codex-web/shared";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "./icons";

const actionIcons = {
  search: "search",
  review: "file",
  code: "terminal",
  image: "image",
  tool: "activity",
};
export function GptSteps({ items }: { items: Progress[] }) {
  return items.length ? (
    <ol className="gpt-public-steps">
      {items.map((item) => (
        <li key={item.id}>
          <Icon name={item.activity ? actionIcons[item.activity] : "chat"} size={17} />
          <span>{item.text}</span>
        </li>
      ))}
    </ol>
  ) : (
    <p className="muted">Для этого запроса нет публичных промежуточных сообщений.</p>
  );
}

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
  const details = useRef<HTMLElement>(null);
  const following = useRef(true);
  const visible = live?.length
    ? [...new Map([...items, ...live].map((item) => [item.id, item])).values()]
    : items;
  const latest = [...visible].reverse().find((item) => item.activity);
  const text = running ? (latest?.text ?? label ?? "GPT работает") : "Этапы ответа";
  // biome-ignore lint/correctness/useExhaustiveDependencies: Follow rendered public output unless the reader scrolled away.
  useLayoutEffect(() => {
    if (details.current && following.current)
      details.current.scrollTop = details.current.scrollHeight;
  }, [text, items, live, open]);
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
          {latest?.activity && <Icon name={actionIcons[latest.activity]} size={17} />}
          <span>{text}</span>
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
          {visible.length ? <GptSteps items={visible} /> : <p>{label ?? "GPT работает"}</p>}
        </section>
      )}
    </section>
  );
}
