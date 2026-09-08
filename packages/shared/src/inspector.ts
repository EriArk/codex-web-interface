export type ProjectFileEntry = {
  name: string;
  path: string;
  kind: "directory" | "file";
  size: number;
  modifiedAt: number;
};
export type ProjectDirectory = {
  path: string;
  entries: ProjectFileEntry[];
  nextOffset: number | null;
  truncated: boolean;
};
export type ProjectGit = {
  repository: boolean;
  branch?: string;
  detached?: boolean;
  ahead?: number;
  behind?: number;
  dirty?: boolean;
  stagedCount?: number;
  workingCount?: number;
  untrackedCount?: number;
  hiddenCount?: number;
  summary?: {
    staged: { files: number; added: number; removed: number };
    working: { files: number; added: number; removed: number };
  };
  changes: { path: string; previousPath?: string; index: string; working: string }[];
  commits: { id: string; subject: string; date: string }[];
};
export type ProjectDiff = { path: string; staged: boolean; text: string; truncated: boolean };
export type InspectRequest =
  | { op: "directory"; path: string; offset: number; search: string }
  | { op: "git" }
  | { op: "diff"; path: string; staged: boolean }
  | { op: "file"; path: string };
