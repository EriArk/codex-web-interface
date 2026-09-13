import { z } from "zod";

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
export interface SharedItem {
  id: string;
  projectId: string;
  kind: SharedItemKind;
  title: string;
  body: string;
  revision: number;
  createdBy: string;
  updatedBy: string;
  createdAt: number;
  updatedAt: number;
  assigneeId?: string;
  status: "open" | "doing" | "done";
  source?: { ownerId: string; client: "codex" | "gpt"; kind: string; id: string; title: string };
}
