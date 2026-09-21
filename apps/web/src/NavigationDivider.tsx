import { useLayoutEffect, useState } from "react";
import { PaneDivider } from "./PaneDivider";

export function NavigationDivider() {
  const [width, setWidth] = useState(() => {
    try {
      const value = Number(localStorage.getItem("codex-navigation-width"));
      return Number.isFinite(value) && value >= 260 && value <= 420 ? value : 0;
    } catch {
      return 0;
    }
  });
  useLayoutEffect(() => {
    if (width) document.documentElement.style.setProperty("--navigation-width", `${width}px`);
  }, [width]);
  return (
    <PaneDivider
      navigation
      value={width || 300}
      onChange={(value) => {
        setWidth(value);
        try {
          localStorage.setItem("codex-navigation-width", String(value));
        } catch {}
      }}
    />
  );
}
