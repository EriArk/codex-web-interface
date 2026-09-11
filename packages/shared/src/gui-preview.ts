import { z } from "zod";

export const guiPreviewActionSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/),
  label: z.string().min(1).max(80),
  capture: z.enum(["window", "desktop-crop"]),
});
export type GuiPreviewAction = z.infer<typeof guiPreviewActionSchema>;
export const guiPreviewReceiptSchema = z.object({
  id: z.string().uuid(),
  actionId: guiPreviewActionSchema.shape.id,
  state: z.enum(["queued", "launching", "waiting", "captured", "failed", "unknown"]),
  appOpen: z.boolean(),
  expiresAt: z.number().int(),
  code: z.string().max(80).optional(),
  capture: z.enum(["window", "desktop-crop"]),
});
export type GuiPreviewReceipt = z.infer<typeof guiPreviewReceiptSchema>;
export type GuiPreviewOperation = GuiPreviewReceipt & {
  projectId: string;
  threadId: string;
  label: string;
  createdAt: number;
  resultId?: string;
  artifact?: { artifactId: string; url: string; width: number; height: number };
  error?: string;
};
export type GuiPreviewRequest =
  | { op: "catalog" }
  | { op: "start"; id: string; actionId: string }
  | {
      op: "status" | "image" | "ack" | "stop";
      id: string;
    };
export type GuiPreviewResponse =
  | { actions: GuiPreviewAction[]; installed: boolean }
  | GuiPreviewReceipt
  | { png: string };
