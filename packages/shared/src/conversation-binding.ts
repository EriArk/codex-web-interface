/** Durable identity only. Every reader/dispatcher must resolve current authorization. */
export type ConversationBindingScope = {
  provider: "codex" | "gpt";
  scope: "user" | "project" | "brainstorm" | "bridge" | "operation" | "system-project";
  scopeId: string;
  role:
    | "work"
    | "intake"
    | "companion"
    | "assistant"
    | "coordinator"
    | "diagnostic"
    | "dispatcher"
    | "worker";
};
export type ConversationBindingSpec = ConversationBindingScope & {
  lifecycle: "persistent" | "rotating" | "job";
  visibility: "normal" | "utility" | "hidden";
  execution: { machineId: string; workingDirectory: string } | null;
};
export type ConversationBinding = ConversationBindingSpec & {
  id: string;
  ownerUserId: string;
  nativeId: string | null;
  jobId: string | null;
  revision: number;
};
