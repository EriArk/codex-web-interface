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
    description: "Тёмный полимер и зелёный фосфор",
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
  const chrome = theme.id === "hitech-2000s" ? caseChrome[color] : theme.chrome;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", chrome);
}

const caseEvent = "codex-case-color-change";
const memory: CasePreferences = {};
const edited = new Set<keyof CasePreferences>();
const caseChrome: Record<CaseColor, string> = {
  graphite: "#253033",
  turquoise: "#114345",
  green: "#284634",
  blue: "#233f5b",
  red: "#532f38",
  orange: "#53372a",
  silver: "#344750",
};
export const caseColorNames: Record<CaseColor, string> = {
  graphite: "Графит",
  turquoise: "Бирюзовый",
  green: "Зелёный",
  blue: "Синий",
  red: "Красный",
  orange: "Оранжевый",
  silver: "Серебристый",
};
export function casePreferenceKey(theme: Theme): keyof CasePreferences {
  return theme === "crt-green" ? "crtCaseColor" : "hitechCaseColor";
}
export function caseColor(theme: Theme): CaseColor {
  const key = casePreferenceKey(theme);
  let value: unknown = memory[key];
  try {
    value ??= localStorage.getItem(`codex-${key}`);
  } catch {
    /* Optional cache. */
  }
  return caseColorIds.find((id) => id === value) ?? (theme === "crt-green" ? "green" : "turquoise");
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
  for (const key of ["crtCaseColor", "hitechCaseColor"] as const) {
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
    for (const key of ["crtCaseColor", "hitechCaseColor"] as const) {
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
