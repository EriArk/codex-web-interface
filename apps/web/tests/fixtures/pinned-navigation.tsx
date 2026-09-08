import { createRoot } from "react-dom/client";
import { GptWorkspace } from "../../src/GptWorkspace";
import { ProjectNavigation } from "../../src/ProjectNavigation";
import "../../src/fonts.css";
import "../../src/styles.css";
import "../../src/workspace.css";
import "../../src/themes.css";
import "../../src/compact.css";

const threads = Array.from({ length: 6 }, (_, i) => ({
  id: "pin" + i,
  projectId: "project",
  title: "Закреплённый " + i,
  status: "idle",
  activeTurnId: null,
  pinned: true,
  updatedAt: new Date(10000 + i * 1000).toISOString(),
  activityAt: new Date(10000 + i * 1000).toISOString(),
  completedSeq: 0,
  seenSeq: 0,
  completedTurnId: null,
  completedStatus: null,
}));
threads.push({
  ...threads[0]!,
  id: "live",
  title: "Активный без закрепления",
  pinned: false,
  status: "running",
});
const root = document.getElementById("root");
if (!root) throw Error("Missing root");
createRoot(root).render(
  location.search.includes("gpt") ? (
    <GptWorkspace
      onCodex={() => {}}
      theme="crt-green"
      onTheme={() => {}}
      onSession={() => {}}
      onLogout={() => {}}
    />
  ) : (
    <aside
      style={{ width: "min(100%, 360px)", height: "100dvh", padding: 12, background: "var(--nav)" }}
    >
      <ProjectNavigation
        projects={[
          {
            id: "project",
            name: "Без проекта",
            machineName: "PC",
            remoteAvailable: false,
            unassigned: true,
          },
        ]}
        activity={{ projects: [], threads, library: [] }}
        threadGroups={{ project: threads }}
        projectId="project"
        threadId=""
        busy={false}
        loading={false}
        machine="online"
        onExpand={async () => {}}
        onThread={(id) => {
          document.body.dataset.selected = id;
        }}
        onNewThread={() => {}}
        onNewProject={() => {}}
        onRefresh={() => {}}
        onClose={() => {}}
        onSettings={() => {}}
      />
    </aside>
  ),
);
