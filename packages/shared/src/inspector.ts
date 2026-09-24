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
  offset?: number;
  total?: number;
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
  commits: { id: string; subject: string; date: string; author?: string }[];
  upstream?: string;
};
export type ProjectDiff = { path: string; staged: boolean; text: string; truncated: boolean };
export type InspectRequest =
  | {
      op: "directory";
      path: string;
      offset: number;
      search: string;
      sort?: "name" | "modified" | "size";
      reveal?: string;
    }
  | { op: "repository" }
  | {
      op: "project-rules" | "project-rules-cancel";
      content: string;
      expected?: string | null;
      key?: string;
    }
  | { op: "project-rules-read"; key?: string }
  | { op: "releases" }
  | { op: "git" }
  | { op: "diff"; path: string; staged: boolean }
  | { op: "index-file"; path: string }
  | { op: "file"; path: string };

export type ProjectRepository = {
  repository: boolean;
  name: string;
  subdirectory?: string;
  remote?: { name: string; owner: string; repo: string; url: string };
  readme: { path: string; text: string; truncated: boolean } | null;
  branches: { name: string; current: boolean; upstream: string }[];
  tags: { name: string; date: string; subject: string }[];
};
export type ProjectReleases = {
  state: "ok" | "unavailable" | "no-remote";
  url?: string;
  checkedAt: number;
  items: {
    id: string;
    name: string;
    tag: string;
    url: string;
    body: string;
    publishedAt: string;
    prerelease: boolean;
    draft: boolean;
    assets: number;
    truncated: boolean;
  }[];
};
