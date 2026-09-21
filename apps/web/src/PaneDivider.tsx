import { useRef } from "react";

/** Percentages are relative to the content area, excluding project navigation. */
export function PaneDivider({
  value,
  onChange,
  navigation = false,
}: {
  value: number;
  onChange: (value: number) => void;
  navigation?: boolean;
}) {
  const drag = useRef<{ pointer: number; x: number; width: number; value: number } | null>(null);
  const min = navigation ? 260 : 28,
    max = navigation ? 420 : 55,
    step = navigation ? 16 : 2;
  const clamp = (value: number) => Math.max(min, Math.min(max, value));
  return (
    <hr
      className={`pane-divider${navigation ? " navigation-divider" : ""}`}
      aria-label={navigation ? "Ширина левой панели" : "Ширина результатов"}
      aria-orientation="vertical"
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onKeyDown={(event) => {
        const values: Record<string, number> = {
          ArrowLeft: value + (navigation ? -step : step),
          ArrowRight: value + (navigation ? step : -step),
          Home: min,
          End: max,
        };
        const next = values[event.key];
        if (next !== undefined) {
          event.preventDefault();
          onChange(clamp(next));
        }
      }}
      onPointerDown={(event) => {
        if (!event.isPrimary || event.button !== 0) return;
        const width = event.currentTarget.parentElement?.clientWidth;
        const pane = (
          navigation ? event.currentTarget.parentElement : event.currentTarget.nextElementSibling
        )?.getBoundingClientRect();
        if (!width || !pane) return;
        drag.current = {
          pointer: event.pointerId,
          x: event.clientX,
          width,
          value: navigation ? pane.width : (100 * pane.width) / width,
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
          clamp(
            start.value +
              (navigation
                ? event.clientX - start.x
                : (100 * (start.x - event.clientX)) / start.width),
          ),
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
