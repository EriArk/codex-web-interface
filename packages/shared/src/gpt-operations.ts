export type GptOperation = {
  id: string;
  nativeId: string;
  messageId: string;
  action: "edit" | "regenerate" | "fork";
  resultNativeId: string | null;
  targetMessageId?: string;
  text: string;
  state: "preparing" | "running" | "completed" | "failed" | "unknown" | "checked";
  error: string;
  createdAt: number;
  updatedAt: number;
};
