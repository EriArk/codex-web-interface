export interface NativeWork {
  turnId: string | null;
  plan?: {
    explanation: string;
    steps: { text: string; status: "pending" | "inProgress" | "completed" }[];
  };
  usage?: { input: number; output: number; cached: number; total: number; capacity: number | null };
  diff?: { text: string; truncated: boolean };
}
export interface NativeCommand {
  itemId: string;
  command: string;
  status: string;
  exitCode: number | null;
  text: string;
  truncated: boolean;
  retainedChars: number;
}
export interface NativeInventory {
  groups: {
    kind: "skills" | "plugins" | "mcp";
    available: boolean;
    more: boolean;
    items: { name: string; description: string; state: string }[];
  }[];
  unsupportedTools: { name: string; count: number }[];
}
