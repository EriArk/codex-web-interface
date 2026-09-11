export interface UsageWindow {
  minutes: number;
  remainingPercent: number;
  resetsAt: number | null;
}
export interface UsageGroup {
  id: string;
  name: string;
  windows: UsageWindow[];
}
export interface ResetCredit {
  id: string;
  resetType: "codexRateLimits" | "unknown";
  status: "available" | "redeeming" | "redeemed" | "unknown";
  grantedAt: number | null;
  expiresAt: number | null;
  title: string | null;
  description: string | null;
}
export interface ResetCredits {
  availableCount: number;
  credits: ResetCredit[] | null;
}
export type ResetOutcome =
  | "reset"
  | "alreadyRedeemed"
  | "nothingToReset"
  | "noCredit"
  | "unsupported";
export interface ResetOperation {
  id: string;
  machineId: string;
  state: "pending" | "unknown" | "complete";
  outcome: ResetOutcome | null;
}
export interface UsageLimitsData {
  available: boolean;
  groups: UsageGroup[];
  resetCredits: ResetCredits | null;
  checkedAt: string;
  resetContext?: string | null;
  resetUnavailable?: string;
  resetOperation?: ResetOperation | null;
}
