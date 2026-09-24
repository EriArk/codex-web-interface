import type { KeyboardEvent } from "react";

/** Use the visible submit control so keyboard sending retains the same readiness/queue guards. */
export function composerShortcut(event: KeyboardEvent<HTMLTextAreaElement>) {
  if (
    event.key !== "Enter" ||
    !(event.ctrlKey || event.metaKey) ||
    event.altKey ||
    event.shiftKey ||
    event.repeat ||
    event.nativeEvent.isComposing
  )
    return;
  event.preventDefault();
  event.currentTarget.form
    ?.querySelector<HTMLButtonElement>('button[type="submit"]:not(:disabled)')
    ?.click();
}
