import { createRoot } from "react-dom/client";
import { ResultFeed } from "../../src/ResultFeed";
import "../../src/styles.css";
import "../../src/workspace.css";
import "../../src/themes.css";
import "../../src/compact.css";
import "../../src/gpt.css";
import "../../src/materials.css";
import "../../src/polymer.css";
import "../../src/accent-colors.css";

createRoot(document.getElementById("root")!).render(
  <div className="support-pane" style={{ height: "100dvh" }}>
    <ResultFeed
      endpoint="/gpt/conversations/chat/results"
      revision={1}
      visible
      onOverlayChange={() => {}}
    />
  </div>,
);
