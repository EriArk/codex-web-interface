import { z } from "zod";
export const planReconciliationPayloadSchema = z
  .object({
    planId: z.string().uuid(),
    revision: z.number().int().positive(),
    items: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            state: z.enum(["complete", "partial", "unknown", "not_done"]),
            note: z.string().max(240).default(""),
            commands: z.array(z.string().min(1).max(2000)).max(5).default([]),
          })
          .strict(),
      )
      .max(200),
  })
  .strict()
  .refine(
    (v) => new Set(v.items.map((i) => i.id)).size === v.items.length,
    "Пункты не должны повторяться",
  );
export type ReconciliationItem = {
  id: string;
  section: string;
  text: string;
  wasChecked: boolean;
  state: "complete" | "verified" | "partial" | "unknown" | "not_done";
  note: string;
  evidenceIds: string[];
};
export type PlanReconciliation = {
  actionId: string;
  planId: string;
  planRevision: number;
  planTitle: string;
  createdAt: number;
  origin: "structured" | "missing" | "invalid";
  items: ReconciliationItem[];
  applied?: { at: number; planRevision: number; itemIds: string[] };
};
export type ReconciliationDetail = {
  proposal: PlanReconciliation;
  planState: "matching" | "changed" | "deleted";
  currentRevision: number | null;
  reviewState: "pending" | "accepted" | "needs_fixes";
  reviewRevision: number;
};
export const reconciliationApplySchema = z
  .object({
    requestId: z.string().uuid(),
    reviewRevision: z.number().int().positive(),
    planRevision: z.number().int().positive(),
    itemIds: z.array(z.string().uuid()).min(1).max(200),
  })
  .strict()
  .refine((v) => new Set(v.itemIds).size === v.itemIds.length, "Пункты не должны повторяться");
export type ReconciliationApply = z.infer<typeof reconciliationApplySchema>;
