import { type ReactNode, useCallback, useEffect, useId, useState } from "react";
import { accountLocalStorage as localStorage } from "./accountStorage.ts";
import { Icon } from "./icons";
import "./pinned-list.css";

// Callers supply activity order and choose whether live work precedes the pinned panel.
export function PinnedList<T extends { id: string; pinned?: boolean }>({
  items,
  renderItem,
  recent,
  active,
  storageKey,
  searching = false,
  activeBeforePinned = true,
  unpinnedPrefix,
}: {
  items: T[];
  renderItem: (item: T) => ReactNode;
  active: (item: T) => boolean;
  recent: (item: T) => number;
  storageKey: string;
  searching?: boolean;
  activeBeforePinned?: boolean;
  unpinnedPrefix?: ReactNode;
}) {
  const key = "pinned-panel:" + storageKey;
  const read = useCallback(() => {
    try {
      return localStorage.getItem(key) === "expanded";
    } catch {
      return false;
    }
  }, [key]);
  const [expanded, setExpanded] = useState(read);
  const id = useId();
  useEffect(() => {
    const sync = () => setExpanded(read());
    const changed = (event: Event) => {
      const detail = (event as CustomEvent<{ key: string; expanded: boolean }>).detail;
      if (detail?.key === key) setExpanded(detail.expanded);
    };
    sync();
    window.addEventListener("storage", sync);
    window.addEventListener("pinned-panel-change", changed);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener("pinned-panel-change", changed);
    };
  }, [key, read]);
  const pinned = items
    .filter((item) => item.pinned)
    .sort((a, b) => Number(active(b)) - Number(active(a)) || recent(b) - recent(a));
  const open = expanded || searching;
  return (
    <>
      {activeBeforePinned && items.filter((item) => !item.pinned && active(item)).map(renderItem)}
      {pinned.length > 0 && (
        <section className="pinned-panel" aria-label="Закреплённые">
          <div className="pinned-heading">Закреплённые</div>
          <div id={id}>{(open ? pinned : pinned.slice(0, 3)).map(renderItem)}</div>
          {pinned.length > 3 && !searching && (
            <button
              type="button"
              className="pinned-toggle"
              aria-expanded={open}
              aria-controls={id}
              aria-label={open ? "Свернуть закреплённые" : "Показать все закреплённые"}
              onClick={() => {
                const next = !expanded;
                setExpanded(next);
                try {
                  localStorage.setItem(key, next ? "expanded" : "collapsed");
                } catch {}
                window.dispatchEvent(
                  new CustomEvent("pinned-panel-change", { detail: { key, expanded: next } }),
                );
              }}
            >
              <Icon name="chevron" size={16} />
            </button>
          )}
        </section>
      )}
      {unpinnedPrefix}
      {!activeBeforePinned && items.filter((item) => !item.pinned && active(item)).map(renderItem)}
      {items.filter((item) => !item.pinned && !active(item)).map(renderItem)}
    </>
  );
}
