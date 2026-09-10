import { useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { useCompletionPosition } from "../../src/useCompletionPosition";

function Fixture() {
  const [mode, setMode] = useState<"codex" | "gpt">("codex"),
    [scope, setScope] = useState("A"),
    [visible, setVisible] = useState(true),
    [active, setActive] = useState(true),
    [long, setLong] = useState(true),
    [late, setLate] = useState(false),
    [font, setFont] = useState(false);
  const scroller = useRef<HTMLDivElement>(null),
    content = useRef<HTMLDivElement>(null),
    following = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Fixture mirrors committed message layout changes.
  useLayoutEffect(() => {
    if (following.current && scroller.current)
      scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [active, long, scope, late]);
  const lock = useCompletionPosition({
    scope: mode + scope,
    enabled: visible,
    following,
    scroller,
    content,
    entries: [
      { id: scope + "-turn", active, complete: !active, target: late ? "" : scope + "-answer" },
    ],
  });
  return (
    <>
      <header style={{ height: 60 }}>Fixed header</header>
      <input aria-label="Draft" defaultValue="Keep draft" />
      <button type="button" onClick={() => setActive(false)}>
        Complete
      </button>
      <button
        type="button"
        onClick={() => {
          setScope("B");
          setActive(false);
        }}
      >
        Other chat
      </button>
      <button type="button" onClick={() => setLong(false)}>
        Short
      </button>
      <button
        type="button"
        onClick={() => {
          following.current = true;
          if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
        }}
      >
        Latest
      </button>
      <button type="button" onClick={() => setVisible((v) => !v)}>
        Toggle view
      </button>
      <button type="button" onClick={() => setMode("gpt")}>
        GPT
      </button>
      <button type="button" onClick={() => setLate((v) => !v)}>
        Delayed row
      </button>
      <button type="button" onClick={() => setFont((v) => !v)}>
        Layout change
      </button>
      <div
        ref={scroller}
        data-testid="scroller"
        style={{ height: 400, overflow: "auto", border: "1px solid" }}
        onScroll={() => {
          if (!lock.current && scroller.current)
            following.current =
              scroller.current.scrollHeight -
                scroller.current.scrollTop -
                scroller.current.clientHeight <
              100;
        }}
      >
        <div ref={content}>
          <div style={{ height: font ? 1800 : 1500 }}>Old messages and progress</div>
          {!late && (
            <article data-message={scope + "-answer"} style={{ height: long ? 1000 : 80 }}>
              <b>Final response starts</b>
              <p>Readable answer</p>
            </article>
          )}
          <div style={{ height: 20 }}>End</div>
        </div>
      </div>
    </>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
