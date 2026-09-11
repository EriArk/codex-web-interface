import { type RefObject, useCallback, useLayoutEffect } from "react";

export function useGrowingComposer(ref: RefObject<HTMLTextAreaElement | null>, value: string) {
  const resize = useCallback(() => {
    const field = ref.current;
    if (!field || !field.getClientRects().length) return;
    const scroll = field.scrollTop;
    field.style.height = "";
    field.style.maxHeight = "";
    const base = field.getBoundingClientRect().height;
    if (!base) return;
    const style = getComputedStyle(field);
    const border =
      (Number.parseFloat(style.borderTopWidth) || 0) +
      (Number.parseFloat(style.borderBottomWidth) || 0);
    const editing = document.activeElement === field;
    const height = editing ? Math.max(base, Math.min(base * 2, field.scrollHeight + border)) : base;
    field.style.maxHeight = `${base * 2}px`;
    field.style.height = `${height}px`;
    field.style.overflowY = editing && field.scrollHeight + border > height + 1 ? "auto" : "hidden";
    field.scrollTop =
      editing && field.selectionEnd === field.value.length ? field.scrollHeight : scroll;
  }, [ref]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Controlled text changes alter scrollHeight.
  useLayoutEffect(resize, [resize, value]);
  useLayoutEffect(() => {
    const field = ref.current;
    if (!field) return;
    field.addEventListener("focus", resize);
    field.addEventListener("blur", resize);
    let width = field.clientWidth;
    const observer = new ResizeObserver(() => {
      if (field.clientWidth !== width) {
        width = field.clientWidth;
        resize();
      }
    });
    observer.observe(field);
    window.addEventListener("resize", resize);
    let disposed = false;
    void document.fonts.ready.then(() => {
      if (!disposed) resize();
    });
    return () => {
      disposed = true;
      observer.disconnect();
      field.removeEventListener("focus", resize);
      field.removeEventListener("blur", resize);
      window.removeEventListener("resize", resize);
    };
  }, [ref, resize]);
}
