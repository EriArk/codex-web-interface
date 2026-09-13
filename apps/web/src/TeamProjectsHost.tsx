import type { NotebookScope, SharedItemKind } from "@codex-web/shared";
import { lazy, Suspense, useEffect, useState } from "react";
import { pageWorkspace } from "./accountStorage";
import { Icon } from "./icons";
import "./shared-projects.css";

const Panel = lazy(() => import("./TeamProjectsPanel"));
export type SharedWorkspaceTarget = {
  projectId?: string;
  scope?: NotebookScope;
  kind?: SharedItemKind;
  itemId?: string;
};
export const openSharedProjects = (target: SharedWorkspaceTarget = {}) =>
  window.dispatchEvent(new CustomEvent("open-shared-projects", { detail: target }));
export function SharedProjectsButton({ scope }: { scope?: NotebookScope }) {
  return pageWorkspace ? (
    <button
      type="button"
      className="secondary shared-project-shortcut"
      onClick={() => openSharedProjects({ scope })}
    >
      <Icon name="folder" size={18} />
      Совместные проекты
    </button>
  ) : null;
}
export function TeamProjectsHost() {
  const [target, setTarget] = useState<SharedWorkspaceTarget>();
  useEffect(() => {
    const open = (event: Event) => {
      if (pageWorkspace) setTarget((event as CustomEvent<SharedWorkspaceTarget>).detail ?? {});
    };
    const close = () => setTarget(undefined);
    window.addEventListener("open-shared-projects", open);
    window.addEventListener("private-session-ended", close);
    return () => {
      window.removeEventListener("open-shared-projects", open);
      window.removeEventListener("private-session-ended", close);
    };
  }, []);
  return target ? (
    <Suspense
      fallback={
        <div className="device-loading" role="status">
          Открываем совместные проекты…
        </div>
      }
    >
      <Panel
        key={JSON.stringify(target)}
        target={target}
        onClose={() => setTarget(undefined)}
        onPersonal={
          target.scope
            ? () => {
                const mode =
                  target.kind === "task"
                    ? "tasks"
                    : target.kind === "plan"
                      ? "plans"
                      : target.kind === "report"
                        ? "reports"
                        : target.kind === "core"
                          ? "core"
                          : target.kind === "review"
                            ? "reviews"
                            : "notes";
                window.dispatchEvent(
                  new CustomEvent("open-workspace-materials", {
                    detail: { scope: target.scope, mode, personal: true },
                  }),
                );
                setTarget(undefined);
              }
            : undefined
        }
      />
    </Suspense>
  ) : null;
}
