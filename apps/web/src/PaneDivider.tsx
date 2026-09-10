import { useRef } from "react";

/** Percentages are relative to the content area, excluding project navigation. */
export function PaneDivider({
  value,
  onChange,
}: {
  value: number;
  onChange: (value: number) => void;
}) {
  const drag = useRef<{ pointer: number; x: number; width: number; value: number } | null>(null);
  return (
    <hr
      className="pane-divider"
      aria-label="Ширина результатов"
      aria-orientation="vertical"
      aria-valuenow={Math.round(value)}
      aria-valuemin={28}
      aria-valuemax={55}
      tabIndex={0}
      onKeyDown={(event) => {
        const values: Record<string, number> = {
          ArrowLeft: value + 2,
          ArrowRight: value - 2,
          Home: 28,
          End: 55,
        };
        const next = values[event.key];
        if (next !== undefined) {
          event.preventDefault();
          onChange(Math.max(28, Math.min(55, next)));
        }
      }}
      onPointerDown={(event) => {
        if (!event.isPrimary || event.button !== 0) return;
        const width = event.currentTarget.parentElement?.clientWidth;
        const pane = event.currentTarget.nextElementSibling?.getBoundingClientRect();
        if (!width || !pane) return;
        drag.current = {
          pointer: event.pointerId,
          x: event.clientX,
          width,
          value: (100 * pane.width) / width,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const start = drag.current;
        if (
          start?.pointer !== event.pointerId ||
          !event.currentTarget.hasPointerCapture(event.pointerId)
        )
          return;
        onChange(
          Math.max(28, Math.min(55, start.value + (100 * (start.x - event.clientX)) / start.width)),
        );
      }}
      onPointerUp={(event) => {
        drag.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
      onLostPointerCapture={() => {
        drag.current = null;
      }}
    />
  );
}
