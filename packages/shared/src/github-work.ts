import { z } from "zod";

export const githubLoginSchema = z
  .string()
  .regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/);
const number = z.number().int().positive().max(2147483647);
const body = z.string().min(1).max(16000);
export const githubWorkInputSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("issue-create"), title: z.string().trim().min(1).max(200), body })
    .strict(),
  z.object({ kind: z.literal("comment"), number, type: z.enum(["issue", "pr"]), body }).strict(),
  z.object({ kind: z.literal("issue-state"), number, state: z.enum(["open", "closed"]) }).strict(),
  z
    .object({
      kind: z.literal("invite"),
      login: githubLoginSchema,
      permission: z.enum(["pull", "push"]),
    })
    .strict(),
  z.object({ kind: z.literal("remove"), login: githubLoginSchema }).strict(),
  z.object({ kind: z.literal("request-review"), number, login: githubLoginSchema }).strict(),
]);
export type GitHubWorkInput = z.infer<typeof githubWorkInputSchema>;
export const githubWorkQuerySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("identity") }).strict(),
  z
    .object({
      kind: z.literal("list"),
      type: z.enum(["issue", "pr"]),
      state: z.enum(["open", "closed", "all"]),
      query: z.string().trim().max(120).default(""),
      page: z.number().int().min(1).max(50).default(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("detail"),
      type: z.enum(["issue", "pr"]),
      number,
      page: z.number().int().min(1).max(50).default(1),
    })
    .strict(),
  z
    .object({ kind: z.literal("collaborators"), page: z.number().int().min(1).max(50).default(1) })
    .strict(),
]);
export type GitHubWorkQuery = z.infer<typeof githubWorkQuerySchema>;
export interface GitHubIdentity {
  id: number;
  login: string;
}
export interface GitHubRepositoryAccess {
  repository: string;
  repositoryId: number | null;
  identity: GitHubIdentity;
  access: "admin" | "maintain" | "write" | "triage" | "read" | "unavailable";
  issues: boolean;
  checkedAt: number;
}
export interface GitHubWorkRecord {
  number: number;
  type: "issue" | "pr";
  title: string;
  body: string;
  truncated: boolean;
  author: GitHubIdentity;
  state: "open" | "closed" | "merged";
  url: string;
  updatedAt: string;
  createdAt: string;
  comments: number;
  assignees: string[];
  labels: string[];
  head?: { branch: string; sha: string; repository: string | null };
  base?: string;
  draft?: boolean;
  reviewers?: string[];
  reviews?: { author: string; state: string; sha: string }[];
  checks?: { name: string; state: string; sha: string }[];
  checksKnown?: boolean;
}
export interface GitHubWorkComment {
  id: number;
  author: GitHubIdentity;
  body: string;
  truncated: boolean;
  createdAt: string;
  url: string;
}
export type GitHubWorkObservation = GitHubRepositoryAccess & {
  query: GitHubWorkQuery;
  items?: GitHubWorkRecord[];
  record?: GitHubWorkRecord;
  commentsPage?: GitHubWorkComment[];
  nextPage?: number | null;
  collaborators?: {
    login: string;
    state: "accepted" | "pending";
    permission: string;
    invitationId?: number;
  }[];
};
export interface GitHubWorkReceipt {
  id: string;
  state: "prepared" | "running" | "completed" | "failed" | "unknown";
  input: GitHubWorkInput;
  fingerprint: string;
  snapshot: GitHubRepositoryAccess;
  baseline?: GitHubWorkRecord;
  createdAt: number;
  updatedAt: number;
  code?: string;
  result?: { url?: string; number?: number; state?: string; login?: string };
}
export type GitHubWorkProbeRequest =
  | { op: "observe"; repository: string; query: GitHubWorkQuery }
  | { op: "prepare"; repository: string; id: string; input: GitHubWorkInput }
  | { op: "apply"; repository: string; id: string; fingerprint: string }
  | { op: "status"; repository: string; id: string };
export type GitHubWorkProbeResult = GitHubWorkObservation | GitHubWorkReceipt | null;

export const teamGitHubSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("material"), id: z.string().uuid() }).strict(),
  z
    .object({
      kind: z.literal("bridge"),
      id: z.string().uuid(),
      entryId: z.string().uuid().optional(),
    })
    .strict(),
]);
export type TeamGitHubSource = z.infer<typeof teamGitHubSourceSchema>;
export const teamGitHubPrepareSchema = z
  .object({
    input: githubWorkInputSchema,
    memberId: z.string().uuid().optional(),
    source: teamGitHubSourceSchema.optional(),
  })
  .strict();
export type TeamGitHubPrepare = z.infer<typeof teamGitHubPrepareSchema>;
export interface TeamGitHubOperation {
  id: string;
  projectId: string;
  userId: string;
  userName: string;
  state: "preparing" | "prepared" | "running" | "completed" | "failed" | "unknown";
  createdAt: number;
  updatedAt: number;
  error?: string;
  machineName: string;
  native?: GitHubWorkReceipt;
  source?: TeamGitHubSource;
  memberId?: string;
}
export interface TeamGitHubLink {
  id: string;
  fingerprint: string;
  projectId: string;
  record: GitHubWorkRecord;
  source?: TeamGitHubSource;
  userId: string;
  userName: string;
  checkedAt: number;
}
