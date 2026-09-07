import { useEffect, useRef, useState } from "react";
import { Icon } from "./icons";
import "./copy.css";

function legacyCopy(text: string) {
  const active = document.activeElement;
  const selection = window.getSelection();
  const ranges = selection
    ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange())
    : [];
  const field = document.createElement("textarea");
  field.value = text;
  field.readOnly = true;
  field.tabIndex = -1;
  field.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;font-size:16px";
  document.body.append(field);
  try {
    field.focus({ preventScroll: true });
    field.select();
    field.setSelectionRange(0, text.length);
    if (!document.execCommand("copy")) throw new Error("COPY_FAILED");
  } finally {
    field.remove();
    if (active instanceof HTMLElement) active.focus({ preventScroll: true });
    if (selection) {
      selection.removeAllRanges();
      for (const range of ranges) selection.addRange(range);
    }
  }
}
export function CopyButton({
  text,
  label = "Копировать сообщение",
}: {
  text: string;
  label?: string;
}) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const attempt = useRef(0);
  useEffect(
    () => () => {
      attempt.current++;
      clearTimeout(timer.current);
    },
    [],
  );
  if (!text) return null;
  const title =
    status === "copied" ? "Скопировано" : status === "failed" ? "Не удалось скопировать" : label;
  return (
    <span className="copy-control" data-copy-state={status}>
      <button
        type="button"
        className="copy-button"
        aria-label={title}
        title={title}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          const current = ++attempt.current;
          clearTimeout(timer.current);
          const finish = (next: "copied" | "failed") => {
            if (attempt.current !== current) return;
            setStatus(next);
            timer.current = setTimeout(() => setStatus("idle"), next === "copied" ? 1800 : 4000);
          };
          try {
            // Start within the tap: WebKit requires transient user activation.
            const write = navigator.clipboard?.writeText(text);
            if (write)
              void write.then(
                () => finish("copied"),
                () => {
                  try {
                    legacyCopy(text);
                    finish("copied");
                  } catch {
                    finish("failed");
                  }
                },
              );
            else {
              legacyCopy(text);
              finish("copied");
            }
          } catch {
            finish("failed");
          }
        }}
      >
        <Icon name={status === "copied" ? "check" : "copy"} size={17} />
      </button>
      <span className={status === "failed" ? "copy-error" : "sr-only"} role="status">
        {status === "idle" ? "" : title}
      </span>
    </span>
  );
}
