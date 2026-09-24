import type { BrainstormCard } from "@codex-web/shared";
import { type RefObject, useEffect, useRef, useState } from "react";
import { Icon } from "./icons";

// Safari must see the gesture boundary on an HTML element, including when a stroke hits an SVG path.
function useTouchSurface(ref: RefObject<HTMLElement | null>, wideOnly = false) {
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const block = (event: TouchEvent) => {
      if (
        wideOnly &&
        (matchMedia("(max-width: 700px)").matches || (node as HTMLButtonElement).disabled)
      )
        return;
      if (event.cancelable) event.preventDefault();
      event.stopPropagation();
    };
    node.addEventListener("touchstart", block, { passive: false });
    node.addEventListener("touchmove", block, { passive: false });
    return () => {
      node.removeEventListener("touchstart", block);
      node.removeEventListener("touchmove", block);
    };
  }, [ref, wideOnly]);
}
export function drawingPath(points: number[][]) {
  let move = true;
  return points
    .map(([x, y]) => {
      if (x === -1) {
        move = true;
        return "";
      }
      const part = `${move ? "M" : "L"}${x},${y}`;
      move = false;
      return part;
    })
    .join(" ");
}

export function DrawingPad({
  points,
  onChange,
}: {
  points: number[][];
  onChange: (points: number[][]) => void;
}) {
  const surface = useRef<HTMLDivElement>(null);
  useTouchSurface(surface);
  const stroke = useRef<{ pointer: number; points: number[][] } | null>(null);
  const [view, setView] = useState(points);
  const frame = useRef(0);
  useEffect(() => {
    if (!stroke.current) setView(points);
  }, [points]);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  const point = (x: number, y: number) => {
    const rect = surface.current!.getBoundingClientRect();
    return [
      Math.round(Math.max(0, Math.min(1000, ((x - rect.left) / rect.width) * 1000))),
      Math.round(Math.max(0, Math.min(600, ((y - rect.top) / rect.height) * 600))),
    ];
  };
  const finish = (pointer: number) => {
    const current = stroke.current;
    if (!current || current.pointer !== pointer) return;
    stroke.current = null;
    cancelAnimationFrame(frame.current);
    frame.current = 0;
    setView(current.points);
    onChange(current.points);
  };
  return (
    <div
      ref={surface}
      className="brainstorm-ink-surface"
      data-swipe-ignore
      onPointerDown={(e) => {
        if (stroke.current || !e.isPrimary || e.button !== 0 || points.length >= 1997) return;
        e.preventDefault();
        e.stopPropagation();
        e.currentTarget.setPointerCapture(e.pointerId);
        const start = point(e.clientX, e.clientY);
        const next = [...points, [-1, -1], start, start];
        stroke.current = { pointer: e.pointerId, points: next };
        setView(next);
      }}
      onPointerMove={(e) => {
        const current = stroke.current;
        if (!current || current.pointer !== e.pointerId) return;
        e.preventDefault();
        e.stopPropagation();
        const events = e.nativeEvent.getCoalescedEvents?.() ?? [];
        for (const event of events.length ? events : [e]) {
          if (current.points.length >= 2000) break;
          const next = point(event.clientX, event.clientY),
            last = current.points.at(-1)!;
          if (Math.hypot(next[0]! - last[0]!, next[1]! - last[1]!) >= 2) current.points.push(next);
        }
        if (!frame.current)
          frame.current = requestAnimationFrame(() => {
            frame.current = 0;
            if (stroke.current) setView([...stroke.current.points]);
          });
      }}
      onPointerUp={(e) => {
        e.preventDefault();
        finish(e.pointerId);
      }}
      onPointerCancel={(e) => finish(e.pointerId)}
      onLostPointerCapture={(e) => finish(e.pointerId)}
    >
      <svg viewBox="0 0 1000 600" role="img" aria-label="Поле рисунка">
        <path
          d={drawingPath(view)}
          fill="none"
          stroke="currentColor"
          strokeWidth="5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}

export type CardPosition = { id: string; x: number; y: number };
export function BoardMove({
  card,
  disabled,
  onPreview,
  onMove,
}: {
  card: BrainstormCard;
  disabled: boolean;
  onPreview: (value: CardPosition | null) => void;
  onMove: (value: BrainstormCard) => void;
}) {
  const handle = useRef<HTMLButtonElement>(null);
  useTouchSurface(handle, true);
  const drag = useRef<{
    pointer: number;
    x: number;
    y: number;
    scroll: HTMLElement;
    sx: number;
    sy: number;
    card: BrainstormCard;
    next: BrainstormCard;
  } | null>(null);
  const title = card.title || "Материал";
  const finish = (save: boolean) => {
    const current = drag.current;
    drag.current = null;
    if (!current) return;
    if (save && (current.card.x !== current.next.x || current.card.y !== current.next.y))
      onMove(current.next);
    else onPreview(null);
  };
  return (
    <button
      ref={handle}
      type="button"
      className="brainstorm-card-move"
      data-swipe-ignore
      disabled={disabled}
      aria-label={`Переместить ${title}`}
      title="Перетащить карточку"
      onPointerDown={(e) => {
        if (!e.isPrimary || e.button !== 0 || matchMedia("(max-width: 700px)").matches) return;
        e.preventDefault();
        e.stopPropagation();
        e.currentTarget.setPointerCapture(e.pointerId);
        const scroll = e.currentTarget.closest<HTMLElement>(".brainstorm-board-scroll")!;
        drag.current = {
          pointer: e.pointerId,
          x: e.clientX,
          y: e.clientY,
          scroll,
          sx: scroll.scrollLeft,
          sy: scroll.scrollTop,
          card,
          next: card,
        };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d || d.pointer !== e.pointerId) return;
        e.preventDefault();
        e.stopPropagation();
        d.next = {
          ...d.card,
          x: Math.round(
            Math.max(0, Math.min(5000, d.card.x + e.clientX - d.x + d.scroll.scrollLeft - d.sx)),
          ),
          y: Math.round(
            Math.max(0, Math.min(5000, d.card.y + e.clientY - d.y + d.scroll.scrollTop - d.sy)),
          ),
        };
        onPreview({ id: card.id, x: d.next.x, y: d.next.y });
      }}
      onPointerUp={() => finish(true)}
      onPointerCancel={() => finish(false)}
      onLostPointerCapture={() => finish(false)}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          finish(false);
          return;
        }
        const direction: Record<string, [number, number]> = {
          ArrowLeft: [-24, 0],
          ArrowRight: [24, 0],
          ArrowUp: [0, -24],
          ArrowDown: [0, 24],
        };
        const d = direction[e.key];
        if (!d || matchMedia("(max-width: 700px)").matches) return;
        e.preventDefault();
        onMove({
          ...card,
          x: Math.max(0, Math.min(5000, card.x + d[0])),
          y: Math.max(0, Math.min(5000, card.y + d[1])),
        });
      }}
    >
      <span className="brainstorm-grip" aria-hidden="true">
        ⠿
      </span>
      <span>{title}</span>
    </button>
  );
}

export function WirePin({
  card,
  disabled,
  selected,
  onSelect,
  onDrag,
  onDrop,
  onCancel,
}: {
  card: BrainstormCard;
  disabled: boolean;
  selected: boolean;
  onSelect: () => void;
  onDrag: (card: BrainstormCard, x: number, y: number) => void;
  onDrop: (card: BrainstormCard, target: string | null) => void;
  onCancel: () => void;
}) {
  const button = useRef<HTMLButtonElement>(null);
  useTouchSurface(button);
  const drag = useRef<{
    id: number;
    x: number;
    y: number;
    moved: boolean;
    card: BrainstormCard;
  } | null>(null);
  return (
    <button
      ref={button}
      type="button"
      className="brainstorm-wire-pin icon-button"
      data-swipe-ignore
      disabled={disabled}
      aria-label={`Соединить ${card.title || "материал"}`}
      aria-pressed={selected}
      title="Потянуть связь к другой карточке"
      onPointerDown={(e) => {
        if (!e.isPrimary || e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false, card };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d || d.id !== e.pointerId) return;
        e.preventDefault();
        e.stopPropagation();
        if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) d.moved = true;
        if (d.moved) onDrag(d.card, e.clientX, e.clientY);
      }}
      onPointerUp={(e) => {
        const d = drag.current;
        drag.current = null;
        if (!d || d.id !== e.pointerId) return;
        e.preventDefault();
        e.stopPropagation();
        if (d.moved) {
          const board = e.currentTarget.closest(".brainstorm-board");
          const target = document
            .elementFromPoint(e.clientX, e.clientY)
            ?.closest<HTMLElement>("[data-card]");
          onDrop(d.card, target && board?.contains(target) ? (target.dataset.card ?? null) : null);
        } else onSelect();
      }}
      onPointerCancel={() => {
        drag.current = null;
        onCancel();
      }}
      onLostPointerCapture={() => {
        if (drag.current) {
          drag.current = null;
          onCancel();
        }
      }}
      onClick={(e) => {
        if (e.detail === 0) onSelect();
      }}
    >
      <Icon name="link" size={18} />
    </button>
  );
}
