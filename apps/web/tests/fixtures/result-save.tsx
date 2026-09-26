import { useState } from "react";
import { DownloadLink } from "../../src/DownloadLink";
import { FileEditorPreview } from "../../src/FileEditorPreview";
import { FileCopySave } from "../../src/FileCopySave";
import { ResultFilePreview } from "../../src/ResultFilePreview";
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
const draft = new File(["# Saved draft\n"], "edited.md", { type: "text/markdown" });
function Fixture() {
  const [opened, setOpened] = useState("");
  return (
    <main style={{ height: "100dvh", display: "flex", flexDirection: "column" }}>
      <nav>
        <DownloadLink href="/api/team/brainstorm-conversions/room-export/export" directDownload>
          Архив комнаты
        </DownloadLink>
        <button onClick={() => setOpened("result")}>Открыть ZIP результата</button>
        <button onClick={() => setOpened("draft")}>Открыть черновик</button>
        <button onClick={() => setOpened("copy")}>Открыть копию</button>
        <DownloadLink
          preparedFile={new File(["zip-bytes"], "installer.zip", { type: "application/zip" })}
          directDownload
        >
          Локальный ZIP
        </DownloadLink>
      </nav>
      {opened === "result" && (
        <ResultFilePreview
          result={{
            ...results[0],
            type: "file",
            title: "diagnostics.zip",
            payload: { url: "/api/artifacts/zip", mime: "application/zip", bytes: 9 },
          }}
          onClose={() => setOpened("")}
        />
      )}
      {opened === "draft" && <FileEditorPreview file={draft} onClose={() => setOpened("")} />}
      {opened === "copy" && (
        <FileCopySave file={draft} onClose={() => setOpened("")} onSaved={() => {}} />
      )}
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
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
