import { type CaseColor, type CasePreferences, caseColorIds } from "@codex-web/shared";

export const themes = [
  {
    id: "organizer",
    title: "Органайзер",
    description: "Бумага, закладки, спокойный зелёный",
    chrome: "#eeece4",
  },
  {
    id: "crt-green",
    title: "Зелёный терминал",
    description: "Цветной пластик и зелёный фосфор",
    chrome: "#061009",
  },
  {
    id: "hitech-2000s",
    title: "Hi-Tech 2000s",
    description: "Цветной корпус и утопленные экраны",
    chrome: "#103e43",
  },
  {
    id: "classic-dark",
    title: "Классическая тёмная",
    description: "Графит, мягкий контраст, ничего лишнего",
    chrome: "#101216",
  },
] as const;

export type Theme = (typeof themes)[number]["id"];

export function cachedTheme(): Theme {
  try {
    return (
      themes.find((theme) => theme.id === localStorage.getItem("codex-theme"))?.id ?? "organizer"
    );
  } catch {
    return "organizer";
  }
}

export function applyTheme(id: Theme) {
  const theme = themes.find((theme) => theme.id === id) ?? themes[0];
  document.documentElement.dataset.theme = theme.id;
  const color = caseColor(theme.id);
  document.documentElement.dataset.caseColor = color;
  const chrome =
    theme.id === "hitech-2000s" || theme.id === "crt-green"
      ? caseChrome(color, theme.id === "crt-green")
      : theme.chrome;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", chrome);
}

const caseEvent = "codex-case-color-change";
const memory: CasePreferences = {};
const edited = new Set<keyof CasePreferences>();
const caseTints: Record<CaseColor, string> = {
  graphite: "#262b32",
  white: "#e2e2db",
  silver: "#929da6",
  red: "#9f3f47",
  orange: "#d08b50",
  yellow: "#dbba5c",
  green: "#3d6d4f",
  mint: "#80baa5",
  turquoise: "#286b70",
  blue: "#3c6292",
  purple: "#74508f",
  pink: "#c07e9c",
};
// Match the opaque low casing stop before the first React render (including iOS chrome).
function caseChrome(color: CaseColor, evening: boolean) {
  return `#${([0, 1, 2] as const)
    .map((i) => {
      const tint = parseInt(caseTints[color].slice(1 + i * 2, 3 + i * 2), 16);
      const base = evening ? tint * 0.42 + ([17, 19, 25] as const)[i] * 0.58 : tint;
      return Math.round(base * 0.9 + ([19, 26, 34] as const)[i] * 0.1)
        .toString(16)
        .padStart(2, "0");
    })
    .join("")}`;
}
const preferenceKeys = [
  "crtCaseColor",
  "hitechCaseColor",
  "organizerAccentColor",
  "darkAccentColor",
] as const;
export const caseColorNames: Record<CaseColor, string> = {
  graphite: "Чёрный",
  white: "Белый",
  yellow: "Жёлтый",
  mint: "Мятный",
  purple: "Фиолетовый",
  pink: "Розовый",
  turquoise: "Бирюзовый",
  green: "Зелёный",
  blue: "Синий",
  red: "Красный",
  orange: "Оранжевый",
  silver: "Серебристый",
};
export function casePreferenceKey(theme: Theme): keyof CasePreferences {
  return {
    "crt-green": "crtCaseColor",
    "hitech-2000s": "hitechCaseColor",
    organizer: "organizerAccentColor",
    "classic-dark": "darkAccentColor",
  }[theme] as keyof CasePreferences;
}
export function caseColor(theme: Theme): CaseColor {
  const key = casePreferenceKey(theme);
  let value: unknown = memory[key];
  try {
    value ??= localStorage.getItem(`codex-${key}`);
  } catch {
    /* Optional cache. */
  }
  return (
    caseColorIds.find((id) => id === value) ??
    (theme === "hitech-2000s" ? "turquoise" : theme === "classic-dark" ? "blue" : "green")
  );
}
function cacheCaseColor(key: keyof CasePreferences, value: CaseColor) {
  memory[key] = value;
  try {
    localStorage.setItem(`codex-${key}`, value);
  } catch {
    /* Keep the session preference. */
  }
}
export function hydrateCaseColors(prefs: CasePreferences) {
  for (const key of preferenceKeys) {
    const value = caseColorIds.find((id) => id === prefs[key]);
    if (!edited.has(key) && value) cacheCaseColor(key, value);
  }
  applyTheme(document.documentElement.dataset.theme as Theme);
  window.dispatchEvent(new Event(caseEvent));
}
export function setCaseColor(theme: Theme, value: CaseColor) {
  const key = casePreferenceKey(theme);
  edited.add(key);
  cacheCaseColor(key, value);
  applyTheme(document.documentElement.dataset.theme as Theme);
  window.dispatchEvent(new Event(caseEvent));
}
export function subscribeCaseColor(listener: () => void) {
  const storage = (event: StorageEvent) => {
    for (const key of preferenceKeys) {
      if (event.key === `codex-${key}` || event.key === null) delete memory[key];
    }
    applyTheme(document.documentElement.dataset.theme as Theme);
    listener();
  };
  window.addEventListener(caseEvent, listener);
  window.addEventListener("storage", storage);
  return () => {
    window.removeEventListener(caseEvent, listener);
    window.removeEventListener("storage", storage);
  };
}
