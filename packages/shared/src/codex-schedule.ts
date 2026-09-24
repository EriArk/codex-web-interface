import { z } from "zod";

export const codexScheduleRuleSchema = z
  .object({
    timezone: z.string().min(1).max(100),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
    weekdays: z.array(z.number().int().min(0).max(6)).max(7),
  })
  .strict();
export const codexScheduleInputSchema = z
  .object({
    text: z.string().trim().min(1).max(12000),
    rule: codexScheduleRuleSchema,
  })
  .strict();
export type CodexScheduleRule = z.infer<typeof codexScheduleRuleSchema>;
export type CodexScheduleInput = z.infer<typeof codexScheduleInputSchema>;
export type CodexScheduleRun = {
  id: string;
  dueAt: number;
  state: "waiting" | "running" | "sent" | "failed" | "unknown" | "cancelled";
  threadId?: string;
  nativeId?: string;
  turnId?: string;
  error?: string;
};
export type CodexSchedule = CodexScheduleInput & {
  id: string;
  revision: number;
  state: "scheduled" | "paused" | "cancelled" | "finished";
  nextAt: number | null;
  last?: CodexScheduleRun;
};
export type CodexScheduleList = {
  target: { key: string; name: string; role: "work" | "intake"; revision: number };
  items: CodexSchedule[];
};
