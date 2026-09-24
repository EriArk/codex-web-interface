import { createRoot } from "react-dom/client";
import { Results } from "../../src/Results";
import type { Result } from "../../src/types";
import "../../src/styles.css";
import "../../src/themes.css";
import "../../src/fonts.css";
import "../../src/materials.css";
import "../../src/polymer.css";
import "../../src/accent-colors.css";

const results = Array.from({ length: 8 }, (_, i) => ({
  id: "image" + i,
  threadId: "thread",
  turnId: "turn",
  type: "image",
  title: "shops-installed-stock.png",
  createdAt: Date.now(),
  payload: { url: "/api/artifacts/image" + i, width: 240, height: 160, bytes: 338000 },
})) as Result[];
createRoot(document.getElementById("root")!).render(
  <main style={{ height: "100dvh", display: "flex", flexDirection: "column" }}>
    <textarea aria-label="Черновик" defaultValue="Мой черновик" />
    <Results
      results={results}
      visible
      category="images"
      focusId=""
      busy={false}
      hasMore={false}
      onOlder={() => {}}
      onOverlayChange={() => {}}
    />
  </main>,
);
