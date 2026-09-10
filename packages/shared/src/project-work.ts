import { z } from "zod";
import type { TurnSettings } from "./index.js";
import { type NotebookTarget, notebookTargetSchema } from "./notebook.js";
import { type ProjectScope, projectScopeSchema } from "./project-core.js";
export const planSectionSchema = z
  .object({
    id: z.string().uuid(),
    title: z.string().trim().min(1).max(120),
    items: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            text: z.string().trim().min(1).max(1000),
            checked: z.boolean(),
          })
          .strict(),
      )
      .max(50),
  })
  .strict();
export const planWriteSchema = z
  .object({
    scope: projectScopeSchema,
    title: z.string().trim().min(1).max(120),
    description: z.string().max(6000),
    sections: z.array(planSectionSchema).max(20),
    links: z.array(notebookTargetSchema).max(8),
    revision: z.number().int().min(0),
    status: z.enum(["draft", "done"]).default("draft"),
  })
  .strict()
  .superRefine((p, ctx) => {
    const items = p.sections.flatMap((s) => s.items);
    if (items.length > 200 || JSON.stringify(p).length > 24000)
      ctx.addIssue({
        code: "custom",
        message: "План слишком большой. Раздели его на несколько планов.",
      });
    const ids = [...p.sections.map((s) => s.id), ...items.map((i) => i.id)];
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({ code: "custom", message: "Пункты плана должны иметь разные идентификаторы." });
  });
export type PlanWrite = z.infer<typeof planWriteSchema>;
export type ProjectPlan = PlanWrite & {
  id: string;
  createdAt: number;
  updatedAt: number;
  latestAction?: ProjectAction;
};
export type PlanSummary = {
  id: string;
  scope: ProjectScope;
  title: string;
  excerpt: string;
  status: "draft" | "done";
  checked: number;
  total: number;
  revision: number;
  createdAt: number;
  updatedAt: number;
  latestAction?: Omit<ProjectAction, "text" | "snapshot">;
};
export type PlanPage = { items: PlanSummary[]; nextOffset: number | null };
export type ActionKind = "plan" | "report" | "rotate" | "correction";
export type ActionState =
  | "prepared"
  | "dispatching"
  | "queued"
  | "running"
  | "completed"
  | "blocked"
  | "unknown"
  | "failed"
  | "cancelled";
export type ProjectAction = {
  id: string;
  scope: ProjectScope;
  kind: ActionKind;
  planId?: string;
  planRevision?: number;
  reviewId?: string;
  reviewRevision?: number;
  title: string;
  text: string;
  state: ActionState;
  threadId: string | null;
  nativeId?: string;
  messageId?: string;
  turnId?: string;
  settings?: TurnSettings;
  gptSettings?: { model: string; effort: string };
  delivery?: "turn" | "queue" | "gpt";
  error?: string;
  errorCode?: string;
  createdAt: number;
  updatedAt: number;
  source?: NotebookTarget;
  snapshot: Record<string, unknown>;
};
export type ProjectReport = {
  id: string;
  scope: ProjectScope;
  title: string;
  body: string;
  createdAt: number;
  periodFrom: number;
  periodTo: number;
  actionId: string;
  source: NotebookTarget;
  watermarks: Record<string, number>;
};
export type ReportPage = {
  items: Omit<ProjectReport, "body" | "watermarks">[];
  nextOffset: number | null;
};
export type CurrentProjectChat = {
  threadId: string | null;
  title: string;
  status: string;
  explicit: boolean;
  revision: number;
  history: { threadId: string; title: string; rotatedAt: number }[];
};
export const actionPrepareSchema = z
  .object({
    scope: projectScopeSchema,
    kind: z.enum(["plan", "report", "rotate", "correction"]),
    planId: z.string().uuid().optional(),
    planRevision: z.number().int().positive().optional(),
    reviewId: z.string().uuid().optional(),
    reviewRevision: z.number().int().positive().optional(),
  })
  .strict()
  .refine((v) => v.kind !== "plan" || (!!v.planId && !!v.planRevision), "Выбери сохранённый план")
  .refine(
    (v) => v.kind !== "correction" || (!!v.reviewId && !!v.reviewRevision),
    "Выбери замечание к работе",
  )
  .refine(
    (v) => v.kind === "plan" || (!v.planId && !v.planRevision),
    "План указывается только для его выполнения",
  )
  .refine(
    (v) => v.kind === "correction" || (!v.reviewId && !v.reviewRevision),
    "Приёмка указывается только для исправления",
  );
export type ActionPrepare = z.infer<typeof actionPrepareSchema>;
