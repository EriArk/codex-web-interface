import { z } from "zod";

export const teamBridgeFields = z
  .object({
    title: z.string().trim().min(1).max(120),
    goal: z.string().trim().min(1).max(6000),
    criteria: z.string().trim().min(1).max(4000),
    budget: z.number().int().min(1).max(10),
  })
  .strict();
export type TeamBridgeFields = z.infer<typeof teamBridgeFields>;
export type TeamBridgeState = "active" | "waiting" | "needs_owner" | "resolved" | "stopped";
export interface TeamBridgeParticipant {
  linkId: string;
  projectId: string;
  projectTitle: string;
  userId: string;
  userName: string;
  linkRevision: number;
  state: "invited" | "accepted" | "declined" | "removed";
}
export interface TeamBridge extends TeamBridgeFields {
  id: string;
  projectId: string;
  projectTitle: string;
  ownerId: string;
  ownerName: string;
  revision: number;
  state: TeamBridgeState;
  participants: TeamBridgeParticipant[];
  createdAt: number;
  updatedAt: number;
}
export const teamBridgeEntrySchema = z
  .object({
    kind: z.enum(["finding", "question", "decision", "work"]),
    text: z.string().trim().min(1).max(8000),
    targetProjectId: z.string().uuid().optional(),
    reference: z
      .string()
      .url()
      .max(500)
      .regex(
        /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(issues|pull)\/[1-9][0-9]*$/,
      )
      .optional(),
  })
  .strict()
  .refine(
    (v) => v.kind !== "work" || (v.text.length <= 6000 && !!v.targetProjectId),
    "Для работы выбери проект и оставь до 6000 символов.",
  );
export interface TeamBridgeEntry {
  id: string;
  seq: number;
  kind: "finding" | "question" | "decision" | "work" | "coordinator" | "consultation" | "status";
  userId: string;
  userName: string;
  text: string;
  targetProjectId?: string;
  reference?: string;
  consultationId?: string;
  createdAt: number;
  planId?: string;
  source?: "own" | "private";
}
export interface TeamBridgeRun {
  id: string;
  ownerId: string;
  ownerName: string;
  state:
    | "prepared"
    | "waiting"
    | "running"
    | "consulting"
    | "unknown"
    | "resolved"
    | "needs_owner"
    | "stopped";
  budget: number;
  consumed: number;
  reason?: string;
  createdAt: number;
  updatedAt: number;
  preview?: { project: string; chat: string; machine: string; prompt: string };
}
export interface TeamBridgeDetail {
  bridge: TeamBridge;
  myProjectId: string;
  canWrite: boolean;
  canCoordinate: boolean;
  canAdopt: boolean;
  run: TeamBridgeRun | null;
  entries: TeamBridgeEntry[];
  nextBefore: number | null;
}
