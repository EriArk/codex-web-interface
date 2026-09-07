import type { ReturnTypeOfSettings } from "./ComposerOptions";
import { Icon } from "./icons";
import "./accessPicker.css";
export function AccessPicker({
  options,
  disabled,
}: {
  options: ReturnTypeOfSettings;
  disabled: boolean;
}) {
  const { selection, caps, saving, change } = options;
  if (!selection || !caps) return null;
  const full = selection.access === "full";
  return (
    <label className={"access-picker" + (full ? " access-full" : "")}>
      <Icon name={full ? "unlock" : "lock"} size={19} />
      <select
        aria-label="Доступ Codex"
        value={selection.access ?? "workspace"}
        disabled={disabled || saving}
        onChange={(e) =>
          void change({ ...selection, access: e.target.value as "workspace" | "full" })
        }
      >
        <option value="workspace">Обычный доступ</option>
        <option value="full" disabled={!caps.accessModes?.includes("full")}>
          Полный доступ
        </option>
      </select>
    </label>
  );
}
