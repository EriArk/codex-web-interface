import { useEffect, useState } from "react";
import { HelpGuide } from "./HelpGuide";
import { Icon } from "./icons";
import "./workspace-window.css";
import "./workspace-help.css";

export type HelpTopic =
  | "home"
  | "codex"
  | "gpt"
  | "results"
  | "files"
  | "editor"
  | "shared"
  | "brainstorm"
  | "activity";
const isTopic = (value: unknown): value is HelpTopic =>
  typeof value === "string" &&
  [
    "home",
    "codex",
    "gpt",
    "results",
    "files",
    "editor",
    "shared",
    "brainstorm",
    "activity",
  ].includes(value);
const eventName = "workspace-open-help";
export function HelpButton({ topic }: { topic?: HelpTopic }) {
  return (
    <button
      type="button"
      className="icon-button workspace-help-button"
      aria-label="Справка и клавиши"
      title="Справка и клавиши (F1)"
      onClick={() => window.dispatchEvent(new CustomEvent(eventName, { detail: topic ?? "home" }))}
    >
      <Icon name="help" />
    </button>
  );
}
export function WorkspaceHelp({ topic = "codex" }: { topic?: HelpTopic }) {
  const [opened, setOpened] = useState<HelpTopic | null>(null);
  useEffect(() => {
    const open = (event: Event) => {
      const requested = (event as CustomEvent).detail;
      setOpened(isTopic(requested) ? requested : topic);
    };
    const key = (event: KeyboardEvent) => {
      if (
        event.key !== "F1" ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        event.isComposing ||
        event.repeat ||
        event.defaultPrevented
      )
        return;
      // Remote/terminal surfaces own their keyboard. Do not steal keys from those sessions.
      const active = document.activeElement;
      if (active?.closest('[data-help-keys="remote"], .remote-pane, .remote-view, .xterm')) return;
      const modal = Array.from(document.querySelectorAll<HTMLDialogElement>("dialog[open]")).at(-1);
      if (
        !modal &&
        Array.from(document.querySelectorAll(".remote-session")).some(
          (element) => element.getClientRects().length,
        )
      )
        return;
      const context =
        active?.closest<HTMLElement>("[data-help-context]")?.dataset.helpContext ??
        modal?.dataset.helpContext ??
        modal?.querySelector<HTMLElement>("[data-help-context]")?.dataset.helpContext;
      event.preventDefault();
      if (!document.querySelector(".workspace-help[open]"))
        setOpened(isTopic(context) ? context : topic);
    };
    window.addEventListener(eventName, open);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener(eventName, open);
      window.removeEventListener("keydown", key);
    };
  }, [topic]);
  return opened ? <HelpGuide initial={opened} onClose={() => setOpened(null)} /> : null;
}
