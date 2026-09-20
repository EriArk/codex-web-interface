import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ResultFeed } from "../../src/ResultFeed";

function Fixture() {
  const [chat, setChat] = useState("a"),
    [serial, setSerial] = useState(0);
  return (
    <>
      {["a", "b"].map((id) => (
        <button
          key={id}
          onClick={() => {
            setChat(id);
            setSerial((n) => n + 1);
          }}
        >
          Chat {id}
        </button>
      ))}
      <button
        onClick={() => {
          window.dispatchEvent(new Event("private-session-ended"));
          setChat("b");
          setSerial((n) => n + 1);
        }}
      >
        Logout
      </button>
      <ResultFeed
        key={serial}
        endpoint={`/gpt/conversations/${chat}/results`}
        revision={1}
        visible
        onOverlayChange={() => {}}
      />
    </>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
