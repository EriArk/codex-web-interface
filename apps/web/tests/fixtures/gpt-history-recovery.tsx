import { createRoot } from "react-dom/client";
import { useGptHistory } from "../../src/useGptHistory";

function Fixture() {
  const h = useGptHistory("history-chat");
  return (
    <>
      <input aria-label="Draft" />
      <button
        type="button"
        onClick={() => void h.history("history-chat", undefined, true).catch(() => {})}
      >
        Refresh
      </button>
      <output data-testid="busy">{String(h.revalidating)}</output>
      <output data-testid="error">{h.error}</output>
      <output data-testid="stale">{String(h.stale)}</output>
      <div>
        {h.messages.map((m) => (
          <p key={m.id}>{m.text}</p>
        ))}
      </div>
    </>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
