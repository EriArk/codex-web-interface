import { useSyncExternalStore } from "react";
import { type Theme, themes } from "./theme";

const layoutKey = "codex-legacy-layout";
const layoutEvent = "codex-layout-change";

function legacyLayout() {
  try {
    return localStorage.getItem(layoutKey) === "true";
  } catch {
    return document.documentElement.dataset.layout === "legacy";
  }
}

export function applyLayoutPreference() {
  document.documentElement.dataset.layout = legacyLayout() ? "legacy" : "refined";
}

function subscribe(listener: () => void) {
  const update = () => {
    applyLayoutPreference();
    listener();
  };
  window.addEventListener(layoutEvent, update);
  window.addEventListener("storage", update);
  return () => {
    window.removeEventListener(layoutEvent, update);
    window.removeEventListener("storage", update);
  };
}

export function AppearanceSettings({
  theme,
  onTheme,
}: {
  theme: Theme;
  onTheme: (id: Theme) => void;
}) {
  const legacy = useSyncExternalStore(subscribe, legacyLayout);
  return (
    <fieldset className="theme-picker">
      <legend>Оформление</legend>
      <div className="theme-options">
        {themes.map(({ id, title, description }) => (
          <label key={id} className={`theme-option ${id}`}>
            <input type="radio" name="theme" checked={theme === id} onChange={() => onTheme(id)} />
            <span className="theme-swatch" />
            <span>
              {title}
              <small>{description}</small>
            </span>
          </label>
        ))}
      </div>
      <label className="layout-preference">
        <input
          type="checkbox"
          checked={legacy}
          onChange={(event) => {
            const value = event.currentTarget.checked;
            document.documentElement.dataset.layout = value ? "legacy" : "refined";
            try {
              localStorage.setItem(layoutKey, String(value));
            } catch {
              /* Device preference is optional. */
            }
            window.dispatchEvent(new Event(layoutEvent));
          }}
        />
        Прежняя компоновка
      </label>
    </fieldset>
  );
}
