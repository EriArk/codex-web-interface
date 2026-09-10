import { z } from "zod";

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export const notebookScopeSchema = z
  .object({
    client: z.enum(["codex", "gpt"]),
    projectId: id,
    name: z.string().trim().min(1).max(120),
  })
  .strict()
  .nullable();
export type NotebookScope = z.infer<typeof notebookScopeSchema>;
export const notebookTargetSchema = z
  .object({
    client: z.enum(["codex", "gpt"]).default("codex"),
    kind: z.enum(["note", "thread", "result", "project", "task", "file", "plan", "report"]),
    id: z
      .string()
      .min(1)
      .max(2048)
      .refine((v) => !Array.from(v).some((c) => c.charCodeAt(0) < 32)),
    title: z.string().trim().min(1).max(200),
    projectId: id.optional(),
    threadId: id.optional(),
    turnId: id.optional(),
    messageId: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[a-zA-Z0-9_:.-]+$/)
      .optional(),
  })
  .strict();
export type NotebookTarget = z.infer<typeof notebookTargetSchema>;
export const noteWriteSchema = z
  .object({
    revision: z.number().int().min(0),
    scope: notebookScopeSchema,
    title: z.string().trim().min(1).max(120),
    body: z.string().max(65536),
    links: z.array(notebookTargetSchema).max(8),
  })
  .strict();
export type NoteWrite = z.infer<typeof noteWriteSchema>;
export type NotebookLink = NotebookTarget & { availability: "available" | "missing" | "unknown" };
export const noteCaptureSchema = z
  .object({
    scope: notebookScopeSchema,
    text: z.string().min(1).max(65536),
    role: z.enum(["user", "assistant"]),
    target: notebookTargetSchema.refine(
      (t) => t.kind === "thread" && !!t.messageId,
      "Нужен источник сообщения",
    ),
  })
  .strict();
export type NoteCapture = z.infer<typeof noteCaptureSchema>;
export type NoteSource = {
  target: NotebookTarget;
  role: "user" | "assistant";
  text: string;
  savedAt: number;
  nativeThreadId: string | null;
};
export type NoteRecord = NoteWrite & {
  source?: NoteSource;
  id: string;
  createdAt: number;
  updatedAt: number;
  resolvedLinks: NotebookLink[];
};
export type NoteSummary = {
  id: string;
  scope: NotebookScope;
  title: string;
  excerpt: string;
  createdAt: number;
  updatedAt: number;
  revision: number;
};
export type NotebookPin = {
  id: string;
  scope: NotebookScope;
  target: NotebookLink;
  createdAt: number;
  pinned: true;
};
export type NotesPage = { items: NoteSummary[]; nextOffset: number | null };
