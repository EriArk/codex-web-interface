import { z } from "zod";

export const projectLinkWrite = z
  .object({
    sourceId: z.string().min(1).max(100),
    targetId: z.string().min(1).max(100),
    label: z.string().trim().max(120).default(""),
    bidirectional: z.boolean().default(true),
    enabled: z.boolean().default(true),
    autoConsult: z.boolean().default(false),
    depth: z.number().int().min(1).max(10).default(1),
    revision: z.number().int().min(0),
  })
  .strict();
export type ProjectLink = z.infer<typeof projectLinkWrite> & {
  id: string;
  createdAt: number;
  updatedAt: number;
};
export const relayRequest = z
  .object({
    linkId: z.string().uuid(),
    sourceId: z.string().min(1).max(100),
    title: z.string().trim().min(1).max(160),
    question: z.string().trim().min(1).max(12000),
    kind: z.enum(["consult", "work"]).default("consult"),
    sourceThreadId: z.string().uuid().optional(),
    sourceTurnId: z.string().max(100).optional(),
  })
  .strict();
export const relayDecision = z
  .object({
    decision: z.enum(["resolved", "continue", "needs_owner"]),
    summary: z.string().trim().min(1).max(8000),
    question: z.string().max(4000),
  })
  .strict();
export type RelayDecision = z.infer<typeof relayDecision>;
export type RelayState =
  | "proposed"
  | "waiting"
  | "running"
  | "unknown"
  | "needs_owner"
  | "resolved"
  | "limit"
  | "stopped"
  | "failed";
export interface RelayStep {
  id: string;
  round: number;
  phase: "question" | "evaluation" | "terminal";
  projectId: string;
  text: string;
  state: "waiting" | "dispatching" | "running" | "unknown" | "completed" | "failed";
  threadId?: string;
  currentRevision?: number;
  turnId?: string;
  messageId?: string;
  answer?: string;
  decision?: RelayDecision;
  createdAt: number;
  completedAt?: number;
}
export interface ProjectRelay extends z.infer<typeof relayRequest> {
  id: string;
  targetId: string;
  state: RelayState;
  revision: number;
  linkRevision: number;
  limit: number;
  consumed: number;
  allowance: number;
  steps: RelayStep[];
  reason?: string;
  createdAt: number;
  updatedAt: number;
  planId?: string;
}
export interface RelayPage {
  links: ProjectLink[];
  items: ProjectRelay[];
  nextOffset: number | null;
  projects: { id: string; name: string }[];
  currents: {
    projectId: string;
    threadId: string | null;
    title: string;
    explicit: boolean;
    revision: number;
  }[];
}
