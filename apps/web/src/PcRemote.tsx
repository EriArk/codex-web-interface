import { useEffect, useRef, useState } from "react";
import { Icon } from "./icons";
import { Remote } from "./Remote";
import type { Machine, Project } from "./types";

export function PcRemote({
  projects,
  machines,
  projectId,
  threadId,
  onClose,
  onSettings,
  onSnapshot,
}: {
  projects: Project[];
  machines: Machine[];
  projectId: string;
  threadId: string;
  onClose: () => void;
  onSettings: () => void;
  onSnapshot: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const choices = projects.filter(
    (p) =>
      !p.deleted &&
      !p.archived &&
      p.remoteAvailable &&
      machines.some((m) => m.id === p.machineId && m.type === "ssh-windows"),
  );
  const byMachine = [...new Map(choices.map((p) => [p.machineId, p])).values()];
  const [selected, setSelected] = useState(
    () =>
      choices.find((p) => p.id === projectId)?.id ??
      (byMachine.length === 1 ? byMachine[0]?.id : ""),
  );
  const target = choices.find((p) => p.id === selected);
  const [, setImmersive] = useState(false);
  useEffect(() => {
    const focus = document.activeElement;
    dialog.current?.showModal();
    dialog.current?.focus({ preventScroll: true });
    return () => {
      if (focus instanceof HTMLElement && focus.isConnected) focus.focus({ preventScroll: true });
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      tabIndex={-1}
      className="pc-remote-dialog"
      aria-label="Remote ПК"
      onCancel={onClose}
    >
      {target ? (
        <Remote
          projectId={target.id}
          threadId={target.id === projectId ? threadId : ""}
          visible
          available
          onBack={onClose}
          onCollapse={onClose}
          onSnapshot={onSnapshot}
          onImmersiveChange={setImmersive}
        />
      ) : (
        <div className="empty-state">
          <button type="button" className="icon-button" aria-label="Назад к чату" onClick={onClose}>
            <Icon name="back" />
          </button>
          <h2>{byMachine.length ? "Выбери компьютер" : "Remote ПК пока не настроен"}</h2>
          {byMachine.map((p) => (
            <button
              type="button"
              className="secondary"
              key={p.machineId}
              onClick={() => setSelected(p.id)}
            >
              <Icon name="remote" />
              {p.machineName}
            </button>
          ))}
          {!byMachine.length && (
            <button type="button" className="secondary" onClick={onSettings}>
              Открыть подключения
            </button>
          )}
        </div>
      )}
    </dialog>
  );
}
