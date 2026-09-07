import { useLayoutEffect, useRef } from "react";

export function useProjectDrawer(open: boolean) {
  const ref = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog || (!open && !dialog.open)) return;
    if (open && !dialog.open) {
      // Native dialog focus must not open the first select on iOS.
      dialog.tabIndex = -1;
      dialog.setAttribute("autofocus", "");
      dialog.showModal();
      dialog.focus({ preventScroll: true });
    }
    dialog.dataset.closing = String(!open);
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || !dialog.animate) {
      if (!open) dialog.close();
      return;
    }
    const frames = [
      { transform: "translateX(calc(-100% - 30px))" },
      { transform: "translateX(0)" },
    ];
    const animation = dialog.animate(open ? frames : [...frames].reverse(), {
      duration: open ? 220 : 160,
      easing: open ? "cubic-bezier(.2,.8,.2,1)" : "cubic-bezier(.4,0,1,1)",
    });
    void animation.finished
      .then(() => {
        if (!open) dialog.close();
      })
      .catch(() => {
        // A new open/close state or unmount cancelled this transition.
      });
    return () => animation.cancel();
  }, [open]);
  return ref;
}
