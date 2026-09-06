import { createRoot } from "react-dom/client";
import App from "./App";
import { applyTheme, cachedTheme } from "./theme";
import "./fonts.css";
import "./styles.css";
import "./workspace.css";
import "./themes.css";
import "./compact.css";
import "./queue.css";
import "./messageImages.css";

applyTheme(cachedTheme());
const root = document.getElementById("root");
if (!root) throw new Error("Missing root");
createRoot(root).render(<App />);
if ("serviceWorker" in navigator)
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }).catch(() => {});
  });
