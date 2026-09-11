import { type CaseColor, caseColorIds } from "@codex-web/shared";
import { useState, useSyncExternalStore } from "react";
import { api } from "./api";
import { Icon } from "./icons";
import {
  caseColor,
  caseColorNames,
  casePreferenceKey,
  setCaseColor,
  subscribeCaseColor,
  type Theme,
} from "./theme";

export function CaseColorSettings({ theme }: { theme: Theme }) {
  const current = useSyncExternalStore(subscribeCaseColor, () => caseColor(theme));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  async function select(color: CaseColor) {
    if (pending || color === current) return;
    setPending(true);
    setError(false);
    setCaseColor(theme, color);
    try {
      await api("/preferences", { method: "PATCH", body: { [casePreferenceKey(theme)]: color } });
    } catch {
      setCaseColor(theme, current);
      setError(true);
    } finally {
      setPending(false);
    }
  }
  return (
    <fieldset className="case-color-picker" disabled={pending}>
      <legend>
        Цвет корпуса <span>{caseColorNames[current]}</span>
      </legend>
      <div className="case-color-options">
        {caseColorIds.map((color) => (
          <button
            key={color}
            type="button"
            className="case-swatch"
            data-case-color={color}
            aria-label={caseColorNames[color]}
            title={caseColorNames[color]}
            aria-pressed={current === color}
            onClick={() => void select(color)}
          >
            {current === color && <Icon name="check" size={18} />}
          </button>
        ))}
      </div>
      {error && (
        <p role="alert" className="case-color-error">
          Не удалось сохранить цвет. Выбери его ещё раз.
        </p>
      )}
    </fieldset>
  );
}
