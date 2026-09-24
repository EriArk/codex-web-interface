import type { CollaborationSpace } from "@codex-web/shared";
import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { GitHubAttention } from "../../src/GitHubAttention";
import { SpaceActivity } from "../../src/SpaceActivity";
import { useWorkspaceDialog } from "../../src/useWorkspaceDialog";
import "../../src/workspace-window.css";
import "../../src/collaboration-spaces.css";
import "../../src/styles.css";
import "../../src/workspace.css";
import "../../src/themes.css";
import "../../src/compact.css";
import "../../src/gpt.css";
import "../../src/materials.css";
import "../../src/polymer.css";
import "../../src/accent-colors.css";

const space: CollaborationSpace = {
  id: "space",
  title: "Совместная разработка приложения с длинным названием",
  kind: "project",
  curatorId: "me",
  revision: 1,
  members: [{ id: "me", name: "Автор" }],
  pending: [],
  unread: 0,
  projects: [
    {
      id: "project",
      name: "Очень длинное название общего проекта",
      ownerId: "me",
      repository: "https://github.com/example/project",
      personalProjectId: "copy",
      access: "owner",
      grants: [],
      requests: [],
    },
  ],
};
function App() {
  const dialog = useRef<HTMLDialogElement>(null);
  useWorkspaceDialog(dialog);
  const [notices, setNotices] = useState(false);
  return (
    <dialog ref={dialog} className="space-dialog activity-dialog workspace-window" tabIndex={-1}>
      <header className="panel-heading">
        <h2>{notices ? "Уведомления" : "Активность"}</h2>
        <button type="button" className="secondary" onClick={() => setNotices((v) => !v)}>
          {notices ? "Лента" : "Уведомления"}
        </button>
      </header>
      <div className="space-dialog-body">
        {notices ? (
          <div className="shared-scroll" style={{ overflow: "auto", padding: 16, width: "100%" }}>
            <GitHubAttention spaces={[space]} onCount={() => {}} />
          </div>
        ) : (
          <SpaceActivity space={space} onProject={() => {}} onDiscuss={() => {}} />
        )}
      </div>
    </dialog>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
