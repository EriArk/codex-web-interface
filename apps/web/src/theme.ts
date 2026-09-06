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
    description: "Фосфор, свечение и стекло CRT",
    chrome: "#061009",
  },
  {
    id: "hitech-2000s",
    title: "Hi-Tech 2000s",
    description: "Холодный металл и синий свет",
    chrome: "#c8d0d6",
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
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme.chrome);
}
