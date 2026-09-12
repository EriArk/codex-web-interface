export interface ScheduledTask {
  id: string;
  title: string;
  prompt: string;
  enabled: boolean;
  schedule: string;
  displaySchedule: string;
  timezone: string;
  timing: string;
  nextRuns: string[];
  lastRun: string | null;
  conversationId: string | null;
  eventDriven: boolean;
  canEdit: boolean;
  canDelete: boolean;
  revision: string;
}
export interface GptCanvas {
  id: string;
  conversationId: string;
  title: string;
  type: string;
  content: string;
  version: number;
  revision: string;
}
export interface NativeWorkspaceReceipt {
  id: string;
  state: "pending" | "unknown" | "completed" | "failed";
  error: string;
  kind: "canvas" | "schedule";
  targetId: string;
}
