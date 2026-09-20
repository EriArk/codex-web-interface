import { type ReactNode, useCallback, useId, useRef, useState } from "react";
import { Icon } from "./icons";
import "./navigationHeader.css";

export function NavigationHeader({
  children,
  query,
  onQuery,
  label,
  onContentSearch,
  onClose,
}: {
  children: ReactNode;
  query: string;
  onQuery: (value: string) => void;
  label: string;
  onContentSearch: () => void;
  onClose: () => void;
}) {
  const [open, setOpen] = useState(false);
  const id = useId(),
    toggle = useRef<HTMLButtonElement>(null);
  const focusSearch = useCallback((node: HTMLInputElement | null) => {
    node?.focus();
  }, []);
  const closeSearch = () => {
    setOpen(false);
    onQuery("");
    toggle.current?.focus();
  };
  return (
    <>
      <div className="navigation-top-row navigation-header">
        <button
          ref={toggle}
          type="button"
          className="icon-button navigation-search-toggle"
          aria-label="Найти"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => (open ? closeSearch() : setOpen(true))}
        >
          <Icon name="search" size={20} />
        </button>
        {children}
        <button
          type="button"
          className="icon-button mobile-only panel-close"
          aria-label="Закрыть проекты"
          data-drawer-close
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </div>
      {open && (
        <div className="nav-search navigation-search-field" id={id}>
          <input
            ref={focusSearch}
            type="search"
            aria-label={label}
            placeholder="Найти…"
            value={query}
            onChange={(event) => onQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                closeSearch();
              }
            }}
          />
          <button
            type="button"
            className="icon-button"
            aria-label="Поиск по содержимому"
            title="Поиск по содержимому"
            onClick={onContentSearch}
          >
            <Icon name="search" size={18} />
          </button>
        </div>
      )}
    </>
  );
}
