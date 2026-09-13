import { lazy, Suspense, useEffect, useState } from "react";
import { accountLocalStorage as localStorage } from "./accountStorage.ts";
import { Icon } from "./icons";

const Panel = lazy(() => import("./GuiPreviewPanel"));
export type GuiPreviewTarget = { projectId: string; projectName: string; threadId?: string };
export function GuiPreviewButton(target: GuiPreviewTarget) {
  return (
    <button
      type="button"
      className="secondary"
      onClick={() => window.dispatchEvent(new CustomEvent("open-gui-preview", { detail: target }))}
    >
      <Icon name="image" size={17} />
      Предпросмотр приложения
    </button>
  );
}
export function GuiPreviewHost() {
  const [target, setTarget] = useState<GuiPreviewTarget>();
  useEffect(() => {
    const open = (e: Event) => setTarget((e as CustomEvent<GuiPreviewTarget>).detail),
      end = () => {
        setTarget(undefined);
        try {
          for (const k of Object.keys(localStorage))
            if (k.startsWith("gui-preview-pending:")) localStorage.removeItem(k);
        } catch {}
      };
    window.addEventListener("open-gui-preview", open);
    window.addEventListener("private-session-ended", end);
    return () => {
      window.removeEventListener("open-gui-preview", open);
      window.removeEventListener("private-session-ended", end);
    };
  }, []);
  return target ? (
    <Suspense
      fallback={
        <div className="device-loading" role="status">
          Открываем предпросмотр…
        </div>
      }
    >
      <Panel key={target.projectId} target={target} onClose={() => setTarget(undefined)} />
    </Suspense>
  ) : null;
}
