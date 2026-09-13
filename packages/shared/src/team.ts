import { z } from "zod";
import { coreValueSchema } from "./project-core.js";
import { planSectionSchema, planWriteSchema } from "./project-work.js";
import { taskFieldsSchema } from "./tasks.js";

export const sharedMaterialFilterSchema = z
  .object({
    mine: z.boolean().default(false),
    author: z.union([z.literal("all"), z.string().uuid()]).default("all"),
    assignee: z.union([z.enum(["all", "none"]), z.string().uuid()]).default("all"),
    state: z.enum(["all", "active", "done"]).default("all"),
  })
  .strict();
export type SharedMaterialFilter = z.infer<typeof sharedMaterialFilterSchema>;

export interface SharedReportDraft {
  id: string;
  projectId: string;
  state: "prepared" | "published" | "cancelled";
  authorName: string;
  createdAt: number;
  content: Extract<SharedMaterial, { kind: "report" }>;
  checkpoint: {
    previousReportId: string | null;
    fromSeq: number;
    toSeq: number;
    observedEvents: number;
    includedEvents: number;
    truncated: boolean;
  };
  itemId?: string;
}
export const sharedReportPublishSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    body: z.string().trim().min(1).max(32000),
    confirm: z.literal(true),
  })
  .strict();

export const teamLoginSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(40)
  .regex(/^[a-z0-9][a-z0-9_.-]*$/);
export const teamNameSchema = z.string().trim().min(1).max(80);
export const teamRoleSchema = z.enum(["admin", "member"]);
export type TeamRole = z.infer<typeof teamRoleSchema>;
export interface TeamUser {
  id: string;
  login: string;
  name: string;
  role: TeamRole;
  state: "active" | "disabled";
  createdAt: number;
}
export interface TeamSession {
  authenticated: true;
  csrf: string;
  expires: number;
  user: TeamUser;
  team: true;
}
export type ProjectMemberRole = "owner" | "collaborator" | "viewer";
export interface SharedProject {
  id: string;
  ownerId: string;
  title: string;
  visibility: "private" | "shared";
  revision: number;
  role: ProjectMemberRole;
  repository?: string;
  archived: boolean;
}
export interface TeamCheckout {
  id: string;
  projectId: string;
  userId: string;
  client: "codex";
  personalProjectId: string;
  machineId: string;
  state: "ready" | "unavailable";
  revision: number;
}
export type SharedItemKind = "core" | "note" | "task" | "plan" | "report" | "review" | "result";
const title = z.string().trim().min(1).max(120);
const text = z.string().max(65536);
export const sharedMaterialSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("note"), title, body: text }).strict(),
  z.object({ kind: z.literal("task"), title, body: text, ...taskFieldsSchema.shape }).strict(),
  z.object({ kind: z.literal("core"), title, value: coreValueSchema }).strict(),
  z
    .object({
      kind: z.literal("plan"),
      title,
      description: z.string().max(6000),
      sections: z.array(planSectionSchema).max(20),
      status: z.enum(["draft", "done"]),
    })
    .strict()
    .refine(
      (value) =>
        planWriteSchema.safeParse({
          title: value.title,
          description: value.description,
          sections: value.sections,
          status: value.status,
          scope: { client: "codex", projectId: "shared", name: "Shared" },
          revision: 0,
          links: [],
        }).success,
      "Проверь размер и уникальность пунктов плана",
    ),
  z
    .object({
      kind: z.literal("report"),
      title,
      body: text,
      periodFrom: z.number().int().nonnegative(),
      periodTo: z.number().int().nonnegative(),
    })
    .strict()
    .refine((value) => value.periodTo >= value.periodFrom, "Проверь период отчёта"),
  z
    .object({
      kind: z.literal("review"),
      title,
      body: text,
      outcome: z.enum(["pending", "accepted", "needs_fixes"]),
      feedback: z.string().max(6000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("result"),
      title,
      body: text,
      outcome: z.enum(["info", "success", "error"]),
    })
    .strict(),
]);
export type SharedMaterial = z.infer<typeof sharedMaterialSchema>;
export const sharedMaterialWriteSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    content: sharedMaterialSchema,
    assigneeId: z.string().uuid().nullable().default(null),
  })
  .strict();
export type SharedMaterialWrite = z.infer<typeof sharedMaterialWriteSchema>;
export interface SharedItem {
  id: string;
  projectId: string;
  kind: SharedItemKind;
  title: string;
  content: SharedMaterial;
  revision: number;
  createdBy: string;
  updatedBy: string;
  createdAt: number;
  updatedAt: number;
  assigneeId: string | null;
  authorName: string;
  editorName: string;
  hasPrivateSource: boolean;
  files?: SharedAsset[];
  related?: { id: string; kind: SharedItemKind; title: string; unavailable: boolean }[];
  // Only returned to its original publisher, never a capability for another member.
  source?: { client: "codex" | "gpt"; kind: SharedItemKind; id: string; projectId: string };
}
export interface SharedAsset {
  id: string;
  name: string;
  mime: string;
  bytes: number;
  sha256: string;
}
export type SharedMember = {
  userId: string;
  name: string;
  login: string;
  role: ProjectMemberRole;
  state: "active" | "disabled";
  revision: number;
  checkoutReady: boolean;
};
export type SharedInvitation = {
  id: string;
  projectId: string;
  projectTitle: string;
  ownerName: string;
  role: ProjectMemberRole;
  expires: number;
};
export type SharedProjectDetail = {
  project: SharedProject;
  members: SharedMember[];
  checkout: TeamCheckout | null;
  invitations?: {
    id: string;
    name: string;
    login: string;
    role: ProjectMemberRole;
    expires: number;
  }[];
};
export type SharedItemSummary = Pick<
  SharedItem,
  | "id"
  | "kind"
  | "title"
  | "revision"
  | "updatedAt"
  | "authorName"
  | "editorName"
  | "assigneeId"
  | "hasPrivateSource"
> & { excerpt: string };

export type SharedExecutionState =
  | "prepared"
  | "queued"
  | "dispatching"
  | "running"
  | "unknown"
  | "completed"
  | "failed"
  | "blocked"
  | "cancelled";
export interface SharedExecution {
  id: string;
  projectId: string;
  itemId: string;
  itemRevision: number;
  title: string;
  userId: string;
  userName: string;
  state: SharedExecutionState;
  ready: boolean;
  createdAt: number;
  updatedAt: number;
  own: boolean;
}
export interface SharedExecutionDetail {
  execution: SharedExecution;
  // Only the acting user's response includes their private execution preview.
  preview?: import("./project-work.js").ProjectAction;
  checkout?: TeamCheckout;
  problem?: string;
}
