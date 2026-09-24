import { EditorView } from "@codemirror/view";
import { createRoot } from "react-dom/client";
import { DownloadLink } from "../../src/DownloadLink";
import { GitHubFilesButton } from "../../src/GitHubFiles";
import { githubDraftStorage } from "../../src/githubDraftStorage";
import "../../src/styles.css";
import "../../src/workspace.css";
import "../../src/themes.css";
import "../../src/compact.css";
import "../../src/gpt.css";
import "../../src/materials.css";
import "../../src/polymer.css";
import "../../src/accent-colors.css";
import { configureApi } from "../../src/api";

Object.assign(window, {
  fixtureDrafts: githubDraftStorage,
  setFixtureEditorText: (text: string) => {
    const view = EditorView.findFromDOM(document.querySelector(".file-editor[open] .cm-editor")!);
    if (!view) throw Error("Missing editor");
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
  },
});
configureApi((window as any).fixtureCsrf, () => {});
createRoot(document.getElementById("root")!).render(
  <main>
    <GitHubFilesButton
      projectId="project"
      projectName="Очень длинное название проекта для проверки заголовка"
    />
    <DownloadLink href={"/api/gpt/text-artifacts/" + "a".repeat(64)} name="Report.md">
      Открыть отчёт
    </DownloadLink>
  </main>,
);
