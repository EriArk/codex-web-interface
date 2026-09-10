import { z } from "zod";
import type { NotebookTarget } from "./notebook.js";
import type { ProjectScope } from "./project-core.js";
import type { ProjectAction } from "./project-work.js";

export const reviewDecisionSchema = z
  .object({
    requestId: z.string().uuid(),
    revision: z.number().int().positive(),
    decision: z.enum(["accepted", "needs_fixes"]),
    note: z.string().trim().max(4000).default(""),
  })
  .strict()
  .refine((v) => v.decision !== "needs_fixes" || !!v.note, "Напиши, что исправить.");
export type ReviewDecision = z.infer<typeof reviewDecisionSchema>;
export type ReviewEvidence = {
  id: string;
  title: string;
  type: string;
  target?: NotebookTarget;
  command?: string;
  commandTruncated?: boolean;
  exitCode?: number;
  status: "passed" | "failed" | "unknown";
};
export type WorkReview = {
  id: string;
  actionId: string;
  scope: ProjectScope;
  title: string;
  revision: number;
  state: "pending" | "accepted" | "needs_fixes";
  note: string;
  decidedAt?: number;
  createdAt: number;
  threadId: string;
  turnId?: string;
  jobId?: string;
  source?: NotebookTarget;
  answer: string;
  answerTruncated: boolean;
  evidence: ReviewEvidence[];
  evidenceTotal: number;
  plan?: { id: string; revision: number; title: string };
  git?: { branch?: string; changed: number; checkedAt: number };
  parentReviewId?: string;
};
export type ReviewSummary = Omit<WorkReview, "answer" | "evidence"> & {
  passed: number;
  failed: number;
};
export type ReviewPage = { items: ReviewSummary[]; nextOffset: number | null };
export type ReviewDetail = {
  review: WorkReview;
  currentThreadId: string | null;
  currentTitle: string;
  correction?: ProjectAction;
};
