import type { NotebookScope, SharedItemKind, TeamGitHubSource } from "@codex-web/shared";
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
  github?: { source?: TeamGitHubSource };
};
export const openSharedProjects = (target: SharedWorkspaceTarget = {}) =>
  window.dispatchEvent(new CustomEvent("open-shared-projects", { detail: target }));
export function SharedProjectsButton({
  scope,
  compact = false,
}: {
  scope?: NotebookScope;
  compact?: boolean;
}) {
  return pageWorkspace ? (
    <button
      type="button"
      className={compact ? undefined : "secondary shared-project-shortcut"}
      aria-label="Общие проекты"
      title="Общие проекты"
      onClick={() => openSharedProjects({ scope })}
    >
      <Icon name="people" size={17} />
      <span>{compact ? "Общие" : "Общие проекты"}</span>
    </button>
  ) : null;
}
export function TeamProjectsHost() {
  const [target, setTarget] = useState<SharedWorkspaceTarget>();
  const [requestId, setRequestId] = useState(0);
  useEffect(() => {
    const open = (event: Event) => {
      if (pageWorkspace) {
        setTarget((event as CustomEvent<SharedWorkspaceTarget>).detail ?? {});
        setRequestId((id) => id + 1);
      }
    };
    const close = () => setTarget(undefined);
    window.addEventListener("open-shared-projects", open);
    window.addEventListener("private-session-ended", close);
    window.addEventListener("open-delivery-target", close);
    return () => {
      window.removeEventListener("open-shared-projects", open);
      window.removeEventListener("private-session-ended", close);
      window.removeEventListener("open-delivery-target", close);
    };
  }, []);
  return target ? (
    <Suspense
      fallback={
        <div className="device-loading" role="status">
          Открываем общие проекты…
        </div>
      }
    >
      <Panel
        key={`${requestId}:${JSON.stringify(target)}`}
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
