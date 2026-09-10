import { z } from "zod";
import type { NotebookScope } from "./notebook.js";
import { type NoteRecord, type NoteSummary, noteWriteSchema } from "./notebook.js";
export const taskStatusSchema = z.enum(["todo", "doing", "blocked", "done"]);
export const taskDueSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => {
    const d = new Date(s + "T00:00:00Z");
    return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, "Некорректная дата")
  .nullable();
export const taskFieldsSchema = z.object({
  status: taskStatusSchema,
  priority: z.number().int().min(0).max(2),
  dueAt: taskDueSchema,
});
export const taskWriteSchema = noteWriteSchema.extend(taskFieldsSchema.shape);
export type TaskFields = z.infer<typeof taskFieldsSchema>;
export type TaskWrite = z.infer<typeof taskWriteSchema>;
export type TaskRecord = NoteRecord & TaskFields & { completedAt: number | null };
export type TaskSummary = NoteSummary & TaskFields & { completedAt: number | null };
export type TasksPage = { items: TaskSummary[]; nextOffset: number | null };

/** Hub metadata only; opening Tasks never reads a native client. */
export type TaskProject = {
  scope: NonNullable<NotebookScope>;
  availability: "available" | "archived" | "missing" | "unknown";
};
export type TaskProjectsPage = { items: TaskProject[]; nextOffset: number | null };
