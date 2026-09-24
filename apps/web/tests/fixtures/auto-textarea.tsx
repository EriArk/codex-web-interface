import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AutoTextarea } from "../../src/AutoTextarea";
import { Icon } from "../../src/icons";
import { applyTheme } from "../../src/theme";
import "../../src/styles.css";
import "../../src/workspace.css";
import "../../src/themes.css";
import "../../src/compact.css";
import "../../src/gpt.css";
import "../../src/materials.css";
import "../../src/polymer.css";
import "../../src/accent-colors.css";
import "../../src/space-chat.css";
import "../../src/workspace-window.css";

function Fixture() {
  const [value, setValue] = useState("");
  const [hidden, setHidden] = useState(false);
  Object.assign(window, { setText: setValue, setHidden, setTheme: applyTheme });
  return (
    <main
      style={{
        height: "100dvh",
        padding: 12,
        display: "flex",
        flexDirection: "column",
        gap: 12,
        maxWidth: 850,
        margin: "auto",
      }}
    >
      <header className="pane-heading">
        <h2>Разговор о проекте</h2>
      </header>
      <div data-testid="scroll" style={{ overflow: "auto", flex: 1, minHeight: 40 }}>
        {Array.from({ length: 15 }, (_, i) => `message-${i}`).map((id, i) => (
          <p key={id}>Сообщение {i + 1}: история остаётся на месте.</p>
        ))}
      </div>
      <form className="composer">
        <div className="composer-input" style={{ display: hidden ? "none" : undefined }}>
          <div className="composer-tools">
            <button className="icon-button" type="button" aria-label="Прикрепить">
              <Icon name="plus" />
            </button>
          </div>
          <AutoTextarea
            aria-label="Сообщение Codex"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Что нужно сделать?"
          />
          <button className="icon-button" type="button" aria-label="Отправить">
            <Icon name="send" />
          </button>
        </div>
      </form>
      <div className="gpt-input-row">
        <AutoTextarea aria-label="Сообщение GPT" defaultValue="Заметка" />
      </div>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
