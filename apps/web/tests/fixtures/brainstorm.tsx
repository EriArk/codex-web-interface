import "../../src/fonts.css";
import "../../src/workspace-window.css";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { configureApi } from "../../src/api";
import { BrainstormWindow } from "../../src/Brainstorm";
import type { SpacesController } from "../../src/useCollaborationSpaces";
import "../../src/styles.css";
import "../../src/workspace.css";
import "../../src/themes.css";
import "../../src/compact.css";
import "../../src/gpt.css";
import "../../src/materials.css";
import "../../src/polymer.css";
import "../../src/accent-colors.css";

configureApi("fixture", () => {});
function Fixture() {
  const [open, setOpen] = useState(true);
  const spaces = {
    open: () => setOpen(false),
    refresh: async () => {},
    select: () => {},
  } as unknown as SpacesController;
  return (
    <>
      <input aria-label="Underlying draft" defaultValue="Do not replace my personal draft" />
      {open && (
        <BrainstormWindow
          id="11111111-1111-4111-8111-111111111111"
          spaces={spaces}
          onProject={() => {}}
        />
      )}
    </>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
