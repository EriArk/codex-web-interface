import { z } from "zod";
import { type NotebookScope, notebookScopeSchema } from "./notebook.js";
import { taskDueSchema } from "./tasks.js";
export const quickCaptureSchema = z
  .object({
    kind: z.enum(["note", "task"]),
    scope: notebookScopeSchema,
    text: z
      .string()
      .min(1)
      .max(65536)
      .refine((v) => !!v.trim(), "Напиши текст записи"),
    title: z.string().trim().max(120).default(""),
    priority: z.number().int().min(0).max(2).default(1),
    dueAt: taskDueSchema.default(null),
  })
  .strict();
export type QuickCaptureInput = z.infer<typeof quickCaptureSchema>;
export const quickCaptureDraftSchema = z.object({
  id: z.string().uuid(),
  input: quickCaptureSchema.extend({ text: z.string().max(65536) }),
  submitted: z.boolean(),
});
export type QuickCaptureDraft = z.infer<typeof quickCaptureDraftSchema>;
export type QuickCaptureReceipt = {
  id: string;
  kind: "note" | "task";
  scope: NotebookScope;
  title: string;
  revision: number;
  availability: "available" | "missing";
};
