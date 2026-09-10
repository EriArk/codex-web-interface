import type { NotebookScope } from "@codex-web/shared";
import { lazy, Suspense, useEffect, useState } from "react";
import { Icon } from "./icons";

const Capture = lazy(() => import("./QuickCapture"));
export function QuickCaptureButton({ scope }: { scope: NotebookScope }) {
  return (
    <button
      type="button"
      className="icon-button quick-capture-shortcut"
      aria-label="Быстрая запись"
      title="Быстрая запись"
      onClick={() => window.dispatchEvent(new CustomEvent("open-quick-capture", { detail: scope }))}
    >
      <Icon name="plus" size={19} />
    </button>
  );
}
export function QuickCaptureHost() {
  const [scope, setScope] = useState<NotebookScope | undefined>();
  useEffect(() => {
    const open = (e: Event) => setScope((e as CustomEvent<NotebookScope>).detail ?? null);
    const end = () => {
      setScope(undefined);
      try {
        localStorage.removeItem("quick-capture-draft");
        localStorage.removeItem("quick-capture-default");
      } catch {}
    };
    window.addEventListener("open-quick-capture", open);
    window.addEventListener("private-session-ended", end);
    return () => {
      window.removeEventListener("open-quick-capture", open);
      window.removeEventListener("private-session-ended", end);
    };
  }, []);
  return scope !== undefined ? (
    <Suspense
      fallback={
        <div className="device-loading" role="status">
          Открываем запись…
        </div>
      }
    >
      <Capture scope={scope} onClose={() => setScope(undefined)} />
    </Suspense>
  ) : null;
}
