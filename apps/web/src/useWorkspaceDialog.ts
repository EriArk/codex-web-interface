import { type RefObject, useEffect } from "react";

/** One native modal lifecycle for workspace tools, independent of their data effects. */
export function useWorkspaceDialog(ref: RefObject<HTMLDialogElement | null>, open = true) {
  useEffect(() => {
    const dialog = ref.current;
    if (!open || !dialog) return;
    const previous = document.activeElement;
    dialog.showModal();
    dialog.focus({ preventScroll: true });
    return () => {
      dialog.close();
      const remaining = Array.from(document.querySelectorAll("dialog[open]")).at(-1);
      if (
        previous instanceof HTMLElement &&
        previous.isConnected &&
        previous.getClientRects().length &&
        (!remaining || remaining.contains(previous))
      )
        previous.focus({ preventScroll: true });
    };
  }, [ref, open]);
}
