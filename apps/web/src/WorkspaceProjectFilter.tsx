const MORE = "load-more";

export function WorkspaceProjectFilter({
  label,
  value,
  choices,
  disabled,
  onChange,
  onMore,
}: {
  label: string;
  value: string;
  choices: ReadonlyArray<readonly [string, string]>;
  disabled: boolean;
  onChange: (value: string) => void;
  onMore?: () => void;
}) {
  return (
    <label className="workspace-project-filter">
      <span>Проект</span>
      <select
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(event) => {
          if (event.target.value === MORE) {
            event.currentTarget.value = value;
            onMore?.();
          } else onChange(event.target.value);
        }}
      >
        {choices.map(([key, name]) => (
          <option key={key} value={key}>
            {name}
          </option>
        ))}
        {onMore && <option value={MORE}>Загрузить ещё проекты…</option>}
      </select>
    </label>
  );
}
