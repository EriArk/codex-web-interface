export type IssueSource = {
  client: "gpt" | "codex";
  threadId: string;
  messageId: string;
  jobId?: string;
  projectId?: string;
  start?: number;
  end?: number;
};
export type IssueDraft = {
  id: string;
  revision: number;
  position: number;
  addedAt: number;
  source: IssueSource;
  original: string;
  title: string;
  body: string;
  targetId: string;
  state: "draft" | "prepared" | "running" | "completed" | "failed" | "unknown" | "cancelled";
  batchId?: string;
  error?: string;
  result?: { number: number; url: string; repositoryId: number };
};
export type IssuePackage = {
  id: string;
  fingerprint: string;
  state: "preparing" | "prepared" | "running" | "settled" | "cancelled";
  items: {
    id: string;
    revision: number;
    title: string;
    body: string;
    projectId: string;
    projectName: string;
    repository: string;
    repositoryId: number;
    identity: { id: number; login: string };
  }[];
  createdAt: number;
};
export type IssueDispatchNotice = {
  id: string;
  projectId: string;
  sender: { id: string; name: string };
  issues: { number: number; url: string }[];
  at: number;
};
