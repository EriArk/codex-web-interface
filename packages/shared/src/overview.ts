import type { NotebookPin, NotebookScope, NoteSummary } from "./notebook.js";
import type { CurrentProjectChat, PlanSummary } from "./project-work.js";
import type { TaskSummary } from "./tasks.js";
export type OverviewThread = {
  id: string;
  title: string;
  status: string;
  active: boolean;
  unread: boolean;
  updatedAt: string;
};
export type OverviewResult = {
  id: string;
  threadId: string;
  turnId?: string;
  title: string;
  type: string;
  createdAt: string;
  imageUrl?: string;
};
export type CachedProjectGit = {
  checkedAt: number;
  root: string;
  repository: boolean;
  branch?: string;
  detached?: boolean;
  dirty?: boolean;
  changed: number;
  error?: boolean;
};
export type ProjectOverview = {
  reviews?: import("./work-review.js").ReviewSummary[];
  currentChat?: CurrentProjectChat;
  plans?: PlanSummary[];
  latestReport?: { id: string; createdAt: number; excerpt: string };
  core?: { revision: number; purpose: string; updatedAt: number };
  scope: NotebookScope;
  generatedAt: number;
  threads: OverviewThread[];
  activity?: { active: number; unread: number };
  notes: NoteSummary[];
  tasks: TaskSummary[];
  pins: NotebookPin[];
  results: OverviewResult[];
  machine?: {
    id: string;
    name: string;
    checkedAt?: number;
    lastSeenAt?: number;
    stale: boolean;
    online?: boolean;
    codex?: boolean;
    remoteAvailable: boolean;
  };
  git?: Omit<CachedProjectGit, "root"> & { stale: boolean };
};
