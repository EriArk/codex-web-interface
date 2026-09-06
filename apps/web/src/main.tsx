import { createRoot } from "react-dom/client";
import App from "./App";
import "./fonts.css";
import "./styles.css";
import "./workspace.css";
import "./themes.css";
import "./compact.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing root");
createRoot(root).render(<App />);
if ("serviceWorker" in navigator)
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
