import { z } from "zod";

export const teamLinkPolicySchema = z
  .object({
    direction: z.enum(["outgoing", "both"]),
    consult: z.boolean(),
    bridge: z.boolean(),
    automatic: z.boolean(),
    depth: z.number().int().min(1).max(10),
  })
  .strict()
  .refine((v) => !v.automatic || v.consult, "Для автоматики нужны консультации");
export type TeamLinkPolicy = z.infer<typeof teamLinkPolicySchema>;
export const teamLinkProposalSchema = z
  .object({
    projectId: z.string().uuid(),
    userId: z.string().uuid(),
    purpose: z.string().trim().min(1).max(1000),
    policy: teamLinkPolicySchema,
  })
  .strict();
export interface TeamLink {
  id: string;
  source: { id: string; title: string; ownerId: string; ownerName: string };
  target: { id: string; title: string; ownerId: string; ownerName: string } | null;
  recipient: { id: string; name: string };
  purpose: string;
  policy: TeamLinkPolicy;
  state: "pending" | "accepted" | "declined" | "revoked";
  revision: number;
  createdAt: number;
  expires: number;
}
export interface TeamContact {
  id: string;
  name: string;
  own: boolean;
}
export const teamConsultRequestSchema = z
  .object({
    linkId: z.string().uuid(),
    projectId: z.string().uuid(),
    title: z.string().trim().min(1).max(160),
    question: z.string().trim().min(1).max(12000),
    kind: z.enum(["consult", "work"]).default("consult"),
  })
  .strict()
  .refine(
    (v) => v.kind !== "work" || (v.question.length <= 6000 && v.title.length <= 120),
    "Предложение работы: заголовок до 120 символов, текст до 6000. Раздели длинное предложение.",
  );
export type TeamConsultState =
  | "proposed"
  | "waiting"
  | "running"
  | "unknown"
  | "needs_owner"
  | "resolved"
  | "limit"
  | "stopped"
  | "failed";
export interface TeamConsultStep {
  id: string;
  projectId: string;
  userId: string;
  userName: string;
  round: number;
  phase: "question" | "evaluation";
  state: "waiting" | "dispatching" | "running" | "unknown" | "completed" | "failed";
  question: string;
  answer?: string;
  createdAt: number;
  completedAt?: number;
}
export interface TeamConsultation {
  id: string;
  linkId: string;
  sourceId: string;
  targetId: string;
  title: string;
  question: string;
  kind: "consult" | "work";
  state: TeamConsultState;
  revision: number;
  initiatorId: string;
  initiatorName: string;
  approvals: string[];
  sourceOwnerId: string;
  targetOwnerId: string;
  limit: number;
  consumed: number;
  steps: TeamConsultStep[];
  reason?: string;
  createdAt: number;
  updatedAt: number;
  planId?: string;
}
