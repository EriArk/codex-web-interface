import { useState } from "react";
import { createRoot } from "react-dom/client";
import { composerShortcut } from "../../src/composerShortcut";
import { FileViewerDialog } from "../../src/FileViewerDialog";
import { HelpButton, WorkspaceHelp } from "../../src/WorkspaceHelp";
import "../../src/styles.css";
import "../../src/themes.css";
import "../../src/fonts.css";
import "../../src/materials.css";
import "../../src/polymer.css";
import "../../src/accent-colors.css";

function Fixture() {
  const [file, setFile] = useState(false),
    [sent, setSent] = useState(0),
    [blocked, setBlocked] = useState(false);
  return (
    <main style={{ padding: 16 }}>
      <WorkspaceHelp topic="gpt" />
      <HelpButton />
      <button type="button" onClick={() => setFile(true)}>
        Файл
      </button>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setSent(sent + 1);
        }}
      >
        <textarea aria-label="Сообщение" defaultValue="Черновик" onKeyDown={composerShortcut} />
        <button type="submit" disabled={blocked}>
          Отправить
        </button>
      </form>
      <button type="button" onClick={() => setBlocked(!blocked)}>
        Блокировка
      </button>
      <output aria-label="Отправлено">{sent}</output>
      <div data-help-keys="remote">
        <input aria-label="Терминал" />
      </div>
      {file && (
        <FileViewerDialog
          name="Очень длинное название документа — рабочие заметки проекта.md"
          onClose={() => setFile(false)}
        >
          <p>Содержимое файла</p>
        </FileViewerDialog>
      )}
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
