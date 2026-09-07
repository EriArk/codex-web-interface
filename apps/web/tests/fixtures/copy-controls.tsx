import { useState } from "react";
import { createRoot } from "react-dom/client";
import Markdown from "react-markdown";
import { CollapsibleCode } from "../../src/CollapsibleCode";
import { CopyButton } from "../../src/CopyButton";
import "../../src/fonts.css";
import "../../src/styles.css";
import "../../src/workspace.css";
import "../../src/themes.css";
import "../../src/compact.css";
import "../../src/gpt.css";

const code = "  const текст = '<&>copy';\n\tconsole.log(текст);\n\n";
const text =
  "Текст для копирования. **Жирный** и [ссылка](https://example.com).\n\n" +
  "\x60\x60\x60text\n" +
  code +
  "\x60\x60\x60";
function Fixture() {
  const [value, setValue] = useState(text);
  return (
    <main style={{ maxWidth: 850, margin: "auto", padding: 16 }}>
      <article className="message">
        <div className="message-meta">
          <span className="avatar">C</span>
          <strong>Codex</strong>
          <CopyButton text={value} />
        </div>
        <div className="message-body">
          <Markdown components={{ pre: CollapsibleCode }}>{value}</Markdown>
        </div>
      </article>
      <section className="gpt-chat">
        <article className="message">
          <div className="message-header">
            <span className="avatar">G</span>
            <b>GPT</b>
            <CopyButton text={value} />
          </div>
          <div className="message-body">
            <Markdown components={{ pre: CollapsibleCode }}>{value}</Markdown>
          </div>
        </article>
      </section>
      <button type="button" onClick={() => setValue(value + "\nНовая часть ответа.")}>
        Добавить часть ответа
      </button>
      <textarea aria-label="Черновик" defaultValue="Мой черновик" />
      <CopyButton text="" />
    </main>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("Fixture root missing");
createRoot(root).render(<Fixture />);
