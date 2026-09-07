import { createRoot } from "react-dom/client";
import { GptWorkspace } from "../../src/GptWorkspace";
import "../../src/fonts.css";
import "../../src/styles.css";
import "../../src/workspace.css";
import "../../src/themes.css";
import "../../src/compact.css";

const root = document.getElementById("root");
if (!root) throw Error("Fixture root missing");
createRoot(root).render(
  <GptWorkspace
    onCodex={() => {}}
    theme="organizer"
    onTheme={() => {}}
    onSession={() => {}}
    onLogout={() => {}}
  />,
);
