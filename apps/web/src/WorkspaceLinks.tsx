import type { ReactNode } from "react";
import { Icon } from "./icons";
import "./workspace-links.css";
export function WorkspaceLinks({
  onTasks,
  onNotes,
  onPlans,
  onReports,
  children,
}: {
  onTasks?: () => void;
  onNotes?: () => void;
  onPlans?: () => void;
  onReports?: () => void;
  children?: ReactNode;
}) {
  const links = [
    ["Задачи", "check", onTasks],
    ["Заметки", "file", onNotes],
    ["Планы", "plan", onPlans],
    ["Отчёты", "report", onReports],
  ] as const;
  return (
    <nav className="workspace-shortcuts" aria-label="Рабочие разделы">
      {links
        .filter(([, , open]) => open)
        .map(([label, icon, open]) => (
          <button type="button" key={label} onClick={open}>
            <Icon name={icon} size={17} />
            <span>{label}</span>
          </button>
        ))}
      {children}
    </nav>
  );
}
