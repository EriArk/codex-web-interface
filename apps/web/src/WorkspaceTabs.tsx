import { Icon } from "./icons";
export type WorkspaceMode = "tasks" | "notes" | "plans" | "reports";
export function WorkspaceTabs({
  mode,
  disabled = false,
  onChange,
}: {
  mode: WorkspaceMode;
  disabled?: boolean;
  onChange: (mode: WorkspaceMode) => void;
}) {
  return (
    <nav className="notebook-modules" aria-label="Разделы проекта">
      {(
        [
          ["tasks", "Задачи", "check"],
          ["notes", "Заметки", "file"],
          ["plans", "Планы", "plan"],
          ["reports", "Отчёты", "report"],
        ] as const
      ).map(([id, label, icon]) => (
        <button
          type="button"
          key={id}
          disabled={disabled}
          aria-pressed={mode === id}
          onClick={() => onChange(id)}
        >
          <Icon name={icon} size={16} />
          {label}
        </button>
      ))}
    </nav>
  );
}
