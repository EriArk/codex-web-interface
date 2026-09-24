import { z } from "zod";
import {
  type PreparationRepository,
  preparationBranchInput,
  preparationFilesInput,
  preparationPrInput,
  preparationSeedInput,
} from "./project-preparation.js";

export const githubLoginSchema = z
  .string()
  .regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/);
const number = z.number().int().positive().max(2147483647);
const body = z.string().min(1).max(16000);
export const repositoryFilePathSchema = z
  .string()
  .min(1)
  .max(240)
  .refine(
    (v) =>
      Array.from(v).every((c) => c !== "\\" && c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127) &&
      v.split("/").every((p) => !!p && p !== "." && p !== ".." && p.toLowerCase() !== ".git"),
  );
export const repositoryFileInput = z
  .object({
    kind: z.literal("repository-file"),
    branch: z.string().min(1).max(240),
    head: z.string().regex(/^[a-f0-9]{40}$/),
    files: z
      .array(
        z
          .object({
            path: repositoryFilePathSchema,
            content: z.string().max(131072),
            previous: z.string().regex(/^[a-f0-9]{40}$/),
          })
          .strict(),
      )
      .length(1),
    title: z.string().trim().min(1).max(200),
  })
  .strict();
export type RepositoryFiles = {
  branch: string;
  head: string;
  path: string;
  entries?: { name: string; path: string; kind: "file" | "directory" }[];
  file?: { path: string; sha: string; content: string | null; bytes: number };
};
export const githubWorkInputSchema = z.discriminatedUnion("kind", [
  repositoryFileInput,
  preparationBranchInput,
  preparationFilesInput,
  preparationSeedInput,
  preparationPrInput,
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
      targetId: z.number().int().positive().optional(),
    })
    .strict(),
  z.object({ kind: z.literal("remove"), login: githubLoginSchema }).strict(),
  z
    .object({
      kind: z.literal("accept-invitation"),
      targetRepository: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}\/[a-zA-Z0-9_.-]{1,100}$/),
      repositoryId: z.number().int().positive(),
      identityId: z.number().int().positive(),
    })
    .strict(),
  z.object({ kind: z.literal("request-review"), number, login: githubLoginSchema }).strict(),
]);
export type GitHubWorkInput = z.infer<typeof githubWorkInputSchema>;
export const githubWorkQuerySchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("repository-files"),
      branch: z.string().max(240),
      path: repositoryFilePathSchema.or(z.literal("")),
    })
    .strict(),
  z
    .object({ kind: z.literal("preparation"), paths: z.array(z.string().min(1).max(240)).max(20) })
    .strict(),
  z
    .object({
      kind: z.literal("evidence"),
      source: z.string().regex(/^(commit:[a-f0-9]{40,64}|(?:pr|issue):[1-9][0-9]{0,9})$/),
    })
    .strict(),
  z.object({ kind: z.literal("activity") }).strict(),
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
  baseSha?: string;
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
  preparation?: PreparationRepository;
  repositoryFiles?: RepositoryFiles;
  commit?: GitHubCommitDetail;
  evidence?: { source: string; text: string; truncated: boolean };
  activity?: GitHubActivitySource[];
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
export type GitHubAttentionKind = "assigned" | "review" | "checks";
export interface GitHubActivitySource {
  attention?: { kind: GitHubAttentionKind; version: string; read?: boolean }[];
  checks?: { sha: string; state: "success" | "pending" | "failure"; total: number; failed: number };
  kind: "commit" | "issue" | "pr";
  key: string;
  title: string;
  author: GitHubIdentity | null;
  authorName: string;
  at: string;
  state?: "open" | "closed" | "merged";
  number?: number;
  sha?: string;
  url: string;
}
export interface SpaceActivityPage {
  viewerId?: number;
  projectId: string;
  repository: string;
  repositoryId: number;
  checkedAt: number;
  items: GitHubActivitySource[];
  social?: Record<string, import("./collaboration.js").ActivitySocialSummary>;
  versions?: Record<string, string>;
  keys?: string[];
  delta?: boolean;
}
export interface GitHubCommitDetail {
  sha: string;
  message: string;
  parents: string[];
  truncated: boolean;
  files: {
    path: string;
    status: string;
    additions: number;
    deletions: number;
    patch: string;
    patchOmitted: boolean;
  }[];
}
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
  result?: {
    url?: string;
    number?: number;
    state?: string;
    login?: string;
    sha?: string;
    branch?: string;
  };
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
