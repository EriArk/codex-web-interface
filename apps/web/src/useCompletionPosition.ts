import { type RefObject, useLayoutEffect, useRef } from "react";
export type CompletionEntry = { id: string; active: boolean; complete: boolean; target: string };
// Each observed live response may settle once. History reads alone never create a transition.
export function useCompletionPosition({
  scope,
  enabled,
  following,
  scroller,
  content,
  entries,
}: {
  scope: string;
  enabled: boolean;
  following: RefObject<boolean>;
  scroller: RefObject<HTMLDivElement | null>;
  content: RefObject<HTMLDivElement | null>;
  entries: CompletionEntry[];
}) {
  const state = useRef({
    scope: "",
    enabled: false,
    observed: new Set<string>(),
    done: new Set<string>(),
    anchor: "",
    target: "",
    align: false,
  });
  const align = useRef(() => {}),
    locked = useRef(false);
  useLayoutEffect(() => {
    const s = state.current;
    if (s.scope !== scope || s.enabled !== enabled) {
      Object.assign(s, {
        scope,
        enabled,
        observed: new Set(),
        done: new Set(),
        anchor: "",
        target: "",
        align: false,
      });
      locked.current = false;
    }
    if (!enabled || !scope || document.hidden) return;
    for (const entry of entries) {
      if (entry.active) {
        if (!s.observed.has(entry.id) && s.anchor) {
          s.anchor = "";
          s.target = "";
          s.align = false;
          locked.current = false;
          following.current = true;
        }
        s.observed.add(entry.id);
      }
      if (entry.complete && s.observed.has(entry.id) && !s.done.has(entry.id)) {
        s.done.add(entry.id);
        if (following.current) {
          s.anchor = entry.id;
          s.target = entry.target;
          s.align = false;
          locked.current = true;
          following.current = false;
        }
      }
    }
    const current = entries.find((entry) => entry.id === s.anchor);
    if (current) s.target = current.target;
    align.current = () => {
      const el = scroller.current,
        target = s.target
          ? el?.querySelector<HTMLElement>(`[data-message="${CSS.escape(s.target)}"]`)
          : null;
      if (!locked.current || !el || !target || !s.enabled || document.hidden) return;
      const box = el.getBoundingClientRect(),
        row = target.getBoundingClientRect();
      const top = row.top - box.top - el.clientTop,
        bottom = row.bottom - box.top;
      // Short answers already fully readable stay in place. Long ones use the actual internal pane.
      if (!s.align && top >= 0 && bottom <= el.clientHeight) return;
      s.align = true;
      following.current = false;
      el.scrollTop += top - 8;
    };
    align.current();
  });
  useLayoutEffect(() => {
    const el = scroller.current,
      body = content.current;
    if (!el || !enabled) return;
    const manual = (event: Event) => {
      if (
        event instanceof KeyboardEvent &&
        !["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)
      )
        return;
      state.current.anchor = "";
      state.current.target = "";
      locked.current = false;
    };
    for (const name of ["wheel", "touchstart", "pointerdown", "keydown"])
      el.addEventListener(name, manual, { passive: true });
    const visibility = () => {
      if (!document.hidden) return;
      state.current.observed.clear();
      state.current.anchor = "";
      state.current.target = "";
      locked.current = false;
    };
    document.addEventListener("visibilitychange", visibility);
    const resize = new ResizeObserver(() => align.current());
    resize.observe(el);
    if (body) resize.observe(body);
    return () => {
      resize.disconnect();
      document.removeEventListener("visibilitychange", visibility);
      for (const name of ["wheel", "touchstart", "pointerdown", "keydown"])
        el.removeEventListener(name, manual);
    };
  }, [enabled, scroller, content]);
  return locked;
}
