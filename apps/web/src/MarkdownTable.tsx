import { type ComponentPropsWithoutRef, useLayoutEffect, useRef, useState } from "react";
import "./markdown-table.css";

export function MarkdownTable({
  node: _node,
  ...props
}: ComponentPropsWithoutRef<"table"> & { node?: unknown }) {
  const viewport = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(false);
  useLayoutEffect(() => {
    const el = viewport.current;
    const table = el?.querySelector("table");
    if (!el || !table) return;
    const measure = () => setOverflow(el.scrollWidth > el.clientWidth + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    observer.observe(table);
    return () => observer.disconnect();
  }, []);
  return (
    <div
      ref={viewport}
      className="markdown-table-scroll"
      data-swipe-ignore
      {...(overflow
        ? { role: "region", "aria-label": "Таблица с горизонтальной прокруткой", tabIndex: 0 }
        : {})}
    >
      <table {...props} />
    </div>
  );
}
