import { createRoot } from "react-dom/client";
import { ResultFeed } from "../../src/ResultFeed";
import { useGptHistory } from "../../src/useGptHistory";
import "../../src/styles.css";
import "../../src/workspace.css";
import "../../src/themes.css";
import "../../src/compact.css";
import "../../src/gpt.css";
import "../../src/materials.css";
import "../../src/polymer.css";
import "../../src/accent-colors.css";

function Fixture() {
  const h = useGptHistory("incremental");
  return (
    <>
      <input aria-label="Draft" />
      <button type="button" onClick={() => void h.history("incremental", undefined, true)}>
        Refresh
      </button>
      <button type="button" onClick={() => h.before && void h.history("incremental", h.before)}>
        Older messages
      </button>
      <output data-testid="busy">{String(h.revalidating)}</output>
      <output data-testid="error">{h.error}</output>
      <div
        ref={h.scroll}
        data-testid="history"
        style={{ height: 150, overflow: "auto" }}
        onScroll={() => {
          h.sticky.current = false;
          h.rememberScroll();
        }}
      >
        {h.messages.map((m) => (
          <p key={m.id} data-message={m.id}>
            {m.text}
          </p>
        ))}
      </div>
      <div className="support-pane" style={{ height: 450 }}>
        <ResultFeed
          endpoint="/gpt/conversations/incremental/results"
          revision={h.revision}
          visible
          onOverlayChange={() => {}}
        />
      </div>
    </>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
