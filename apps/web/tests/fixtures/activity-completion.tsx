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
  const multi = new URLSearchParams(location.search).has("multi");
  const [notices, setNotices] = useState(multi),
    [reverse, setReverse] = useState(false);
  const projects = multi
    ? Array.from({ length: 4 }, (_, i) => ({
        ...space.projects[0]!,
        id: "project" + i,
        personalProjectId: "copy" + i,
        name: "Project " + i,
      }))
    : space.projects;
  const current = { ...space, projects: reverse ? [...projects].reverse() : projects };
  return (
    <dialog
      ref={dialog}
      className={`space-dialog workspace-window${notices ? "" : " activity-dialog"}`}
      tabIndex={-1}
    >
      <header className="panel-heading">
        <h2>{notices ? "Уведомления" : "Активность"}</h2>
        <button type="button" className="secondary" onClick={() => setNotices((v) => !v)}>
          {notices ? "Лента" : "Уведомления"}
        </button>
      </header>
      {multi && (
        <button type="button" onClick={() => setReverse((v) => !v)}>
          Порядок
        </button>
      )}
      <div className="space-dialog-body">
        {notices ? (
          <div>
            <GitHubAttention spaces={[current]} onCount={() => {}} />
          </div>
        ) : multi ? (
          <p>Лента закрыта</p>
        ) : (
          <SpaceActivity space={space} onProject={() => {}} onDiscuss={() => {}} />
        )}
      </div>
    </dialog>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
