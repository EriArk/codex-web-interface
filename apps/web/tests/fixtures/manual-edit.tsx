import { createRoot } from "react-dom/client";
import { DownloadLink } from "../../src/DownloadLink";
import { GitHubFilesButton } from "../../src/GitHubFiles";
import "../../src/styles.css";
import "../../src/workspace.css";
import "../../src/themes.css";
import "../../src/compact.css";
import "../../src/gpt.css";
import "../../src/materials.css";
import "../../src/polymer.css";
import "../../src/accent-colors.css";
import { configureApi } from "../../src/api";

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
