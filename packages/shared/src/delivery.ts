import { z } from "zod";
export const deliveryInputSchema = z
  .object({
    kind: z.enum(["commit", "push", "pr", "sync"]),
    paths: z.array(z.string().min(1).max(2048)).max(200).default([]),
    message: z.string().trim().max(2000).default(""),
    title: z.string().trim().max(200).default(""),
    body: z.string().max(20000).default(""),
    syncScope: z.string().length(64).optional(),
    reviewId: z.string().uuid().optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (new TextEncoder().encode(JSON.stringify(v)).length > 100000)
      ctx.addIssue({ code: "custom", message: "Выбери меньше файлов для одной операции" });
    if (v.kind === "sync" && !v.syncScope)
      ctx.addIssue({ code: "custom", message: "Обнови привязку рабочей копии" });
    if (v.kind === "commit" && (!v.paths.length || !v.message))
      ctx.addIssue({ code: "custom", message: "Выбери файлы и напиши сообщение коммита" });
    if (v.kind === "pr" && !v.title)
      ctx.addIssue({ code: "custom", message: "Напиши название PR" });
    if (new Set(v.paths).size !== v.paths.length)
      ctx.addIssue({ code: "custom", message: "Файлы не должны повторяться" });
  });
export type DeliveryInput = z.infer<typeof deliveryInputSchema>;
export type DeliveryCheck = {
  name: string;
  state: "pending" | "passed" | "failed" | "cancelled" | "skipped";
  url?: string;
};
export type DeliveryPr = {
  number: number;
  title: string;
  url: string;
  head: string;
  base: string;
  sha: string;
  body: string;
  mergeable: boolean | null;
};
export type DeliveryGitHub = {
  state: "ok" | "unavailable" | "no-remote";
  repository?: string;
  url?: string;
  defaultBranch?: string;
  remoteHead?: string | null;
  pr?: DeliveryPr;
  checks: DeliveryCheck[];
  checksSha?: string;
  checksKnown?: boolean;
};
export type CheckoutSync = {
  status: "current" | "behind" | "local" | "conflict" | "dirty" | "unavailable";
  baseRef?: string;
  baseSha?: string;
  commonSha?: string;
  repositoryId?: number;
  githubUserId?: number;
  gitDirectory?: string;
  commonDirectory?: string;
  ahead?: number;
  behind?: number;
  tree?: string;
  conflicts: { path: string; preview: string | null }[];
  conflictsTotal: number;
};
export type CheckoutProvenance = {
  scope: string;
  spaceId: string;
  projectId: string;
  ownerId: string;
  ownerProjectId: string;
  participantId: string;
  repository: string;
  machineId: string;
  root: string;
  branch: string | null;
  head: string | null;
  adoptedAt: number;
  baseline: CheckoutSync;
};
export type DeliveryState = {
  sync?: CheckoutSync;
  repository: boolean;
  branch: string | null;
  head: string | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  changed: number;
  staged: number;
  untracked: number;
  hidden: number;
  paths: { path: string; index: string; working: string; size: number; hash: string }[];
  truncated: boolean;
  github: DeliveryGitHub;
  checkedAt: number;
  fingerprint: string;
};
export type DeliveryMachineReceipt = {
  id: string;
  kind: DeliveryInput["kind"];
  state: "prepared" | "running" | "completed" | "failed" | "unknown";
  fingerprint: string;
  snapshot: DeliveryState;
  input: DeliveryInput;
  createdAt: number;
  updatedAt: number;
  code?: string;
  commit?: string;
  pr?: DeliveryPr;
};
export type DeliveryOperation = DeliveryMachineReceipt & {
  projectId: string;
  projectName: string;
  machineId: string;
  error?: string;
};
export type DeliveryObservation = {
  id: string;
  projectId: string;
  projectName: string;
  state: DeliveryState;
  checkout?: CheckoutProvenance;
  checkoutUnavailable?: boolean;
  createdAt: number;
};
export type DeliveryProbeRequest =
  | { op: "inspect"; sync?: boolean }
  | { op: "prepare"; id: string; input: DeliveryInput }
  | { op: "apply"; id: string; fingerprint: string }
  | { op: "status"; id: string };
export type DeliveryProbeResult = DeliveryState | DeliveryMachineReceipt | null;
