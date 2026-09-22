import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatNavigation } from "../../src/ChatNavigation";

const height = 140;

function Fixture() {
  const [items, setItems] = useState(["m2", "internal", "m3", "m4"]);
  const [hasOlder, setHasOlder] = useState(true);
  const [hasNewer, setHasNewer] = useState(false);
  const [olderCalls, setOlderCalls] = useState(0);
  const [newerCalls, setNewerCalls] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const following = useRef(true);

  const loadOlder = async () => {
    setOlderCalls((n) => n + 1);
    setItems((old) => ["m0", "m1", ...old]);
    setHasOlder(false);
  };
  const loadNewer = async () => {
    setNewerCalls((n) => n + 1);
    setItems(["m2", "internal", "m3", "m4", "m5"]);
    setHasNewer(false);
  };

  return (
    <main
      className="chat-pane"
      style={
        {
          width: 360,
          height: 360,
          display: "flex",
          flexDirection: "column",
          "--surface": "#fff",
          "--soft": "#eee",
          "--line": "#999",
          "--shadow": "0 2px 8px #0002",
          "--ink": "#111",
        } as React.CSSProperties
      }
    >
      <input aria-label="Draft" defaultValue="Keep draft" />
      <button
        type="button"
        onClick={() => {
          setItems(["m2", "internal", "m3"]);
          setHasOlder(false);
          setHasNewer(true);
          requestAnimationFrame(() => {
            if (scroller.current) scroller.current.scrollTop = 0;
          });
        }}
      >
        Fragment
      </button>
      <output data-testid="older-calls">{olderCalls}</output>
      <output data-testid="newer-calls">{newerCalls}</output>
      <div
        ref={scroller}
        data-testid="scroller"
        style={{ minHeight: 0, flex: 1, overflow: "auto", border: "1px solid #999" }}
        onScroll={() => {
          if (scroller.current)
            following.current =
              scroller.current.scrollHeight -
                scroller.current.scrollTop -
                scroller.current.clientHeight <
              100;
        }}
      >
        {items.map((id) => (
          <article
            key={id}
            data-message={id}
            data-chat-nav={id === "internal" ? undefined : "true"}
            style={{ height, borderBottom: "1px solid #ccc" }}
          >
            {id}
          </article>
        ))}
      </div>
      <ChatNavigation
        scroller={scroller}
        hasOlder={hasOlder}
        loadOlder={loadOlder}
        hasNewer={hasNewer}
        loadNewer={loadNewer}
        onNavigate={() => {
          following.current = false;
        }}
        onEnd={() => {
          following.current = true;
        }}
      />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
