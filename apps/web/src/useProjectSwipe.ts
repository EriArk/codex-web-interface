import { type RefObject, useEffect, useRef } from "react";
export interface SwipePoint {
  x: number;
  y: number;
  time: number;
}
export function opensProjects(start: SwipePoint, end: SwipePoint): boolean {
  const dx = end.x - start.x,
    dy = Math.abs(end.y - start.y),
    elapsed = end.time - start.time;
  return elapsed >= 0 && elapsed < 1000 && dx >= 64 && dx > dy * 1.6;
}
export function useProjectSwipe(
  root: RefObject<HTMLDivElement | null>,
  enabled: boolean,
  open: () => void,
) {
  const callback = useRef(open);
  callback.current = open;
  useEffect(() => {
    const el = root.current;
    if (!el || !enabled) return;
    let start: SwipePoint | undefined;
    const begin = (event: TouchEvent) => {
      start = undefined;
      if (
        event.touches.length !== 1 ||
        el.clientWidth >= 1100 ||
        document.querySelector("dialog[open]")
      )
        return;
      const target = event.target;
      if (
        !(target instanceof Element) ||
        target.closest(
          "button,a,input,textarea,select,[contenteditable],dialog,[data-swipe-ignore],.remote-workspace",
        )
      )
        return;
      const touch = event.touches[0]!,
        rect = el.getBoundingClientRect();
      if (touch.clientX < rect.left || touch.clientX > rect.left + 28) return;
      start = { x: touch.clientX, y: touch.clientY, time: performance.now() };
    };
    const move = (event: TouchEvent) => {
      if (!start) return;
      if (event.touches.length !== 1) {
        start = undefined;
        return;
      }
      const touch = event.touches[0]!,
        dx = touch.clientX - start.x,
        dy = Math.abs(touch.clientY - start.y);
      if (dx < -8 || (dy > 14 && dy > Math.abs(dx))) {
        start = undefined;
        return;
      }
      if (dx > 12 && dx > dy * 1.6 && event.cancelable) event.preventDefault();
    };
    const end = (event: TouchEvent) => {
      const initial = start;
      start = undefined;
      if (!initial || event.touches.length || event.changedTouches.length !== 1) return;
      const touch = event.changedTouches[0]!;
      if (opensProjects(initial, { x: touch.clientX, y: touch.clientY, time: performance.now() }))
        callback.current();
    };
    const cancel = () => {
      start = undefined;
    };
    el.addEventListener("touchstart", begin, { passive: true });
    el.addEventListener("touchmove", move, { passive: false });
    el.addEventListener("touchend", end, { passive: true });
    el.addEventListener("touchcancel", cancel, { passive: true });
    return () => {
      el.removeEventListener("touchstart", begin);
      el.removeEventListener("touchmove", move);
      el.removeEventListener("touchend", end);
      el.removeEventListener("touchcancel", cancel);
    };
  }, [enabled, root]);
}
