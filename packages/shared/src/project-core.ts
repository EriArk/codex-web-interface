import { z } from "zod";
import { notebookScopeSchema } from "./notebook.js";
export const projectScopeSchema = notebookScopeSchema.unwrap();
export type ProjectScope = z.infer<typeof projectScopeSchema>;
export const coreFields = [
  "purpose",
  "behavior",
  "rules",
  "constraints",
  "architecture",
  "preferences",
] as const;
export const coreValueSchema = z
  .object({
    purpose: z.string().max(3000),
    behavior: z.string().max(3000),
    rules: z.string().max(3000),
    constraints: z.string().max(3000),
    architecture: z.string().max(3000),
    preferences: z.string().max(3000),
  })
  .strict();
export type CoreValue = z.infer<typeof coreValueSchema>;
export const emptyCore: CoreValue = {
  purpose: "",
  behavior: "",
  rules: "",
  constraints: "",
  architecture: "",
  preferences: "",
};
export const coreWriteSchema = z
  .object({ scope: projectScopeSchema, revision: z.number().int().min(0), value: coreValueSchema })
  .strict();
export type CoreWrite = z.infer<typeof coreWriteSchema>;
export type ProjectCore = CoreWrite & { createdAt: number; updatedAt: number };
export const coreLabels: Record<keyof CoreValue, string> = {
  purpose: "Назначение",
  behavior: "Как должно работать",
  rules: "Правила работы",
  constraints: "Ограничения и границы",
  architecture: "Архитектура",
  preferences: "Предпочтения",
};
export type CoreHistoryPage = {
  items: { revision: number; createdAt: number }[];
  nextOffset: number | null;
};
