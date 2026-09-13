import { type ComponentProps, useEffect, useRef } from "react";
import { ProjectOverview } from "./ProjectOverview";
export function ProjectOverviewModal({
  onClose,
  ...props
}: ComponentProps<typeof ProjectOverview> & { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null),
    previous = useRef<HTMLElement | null>(null);
  useEffect(() => {
    previous.current = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    dialog.current?.focus();
    return () => {
      dialog.current?.close();
      if (previous.current?.isConnected) previous.current.focus({ preventScroll: true });
    };
  }, []);
  const action = (callback: (() => void) | undefined) =>
    callback
      ? () => {
          onClose();
          callback();
        }
      : undefined;
  return (
    <dialog
      ref={dialog}
      tabIndex={-1}
      className="project-overview-modal"
      aria-label={`Обзор проекта ${props.scope.name}`}
      onCancel={onClose}
    >
      <ProjectOverview
        {...props}
        onClose={onClose}
        onTarget={(target) => {
          onClose();
          props.onTarget(target);
        }}
        onNotebook={(request) => {
          onClose();
          props.onNotebook(request);
        }}
        onNew={action(props.onNew)}
        onFiles={action(props.onFiles)}
        onGit={action(props.onGit)}
        onMachines={action(props.onMachines)}
        onResults={action(props.onResults)}
        onRemote={action(props.onRemote)}
      />
    </dialog>
  );
}
