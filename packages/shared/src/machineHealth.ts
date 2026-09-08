export type DiagnosticCheck = {
  layer:
    | "transport"
    | "executable"
    | "companion"
    | "protocol"
    | "account"
    | "models"
    | "remote"
    | "gateway";
  state: "ok" | "error" | "warning" | "skipped";
  code: string;
};
export type MachineProbe = {
  checkedAt: number;
  online: boolean;
  codexVersion?: string;
  checks: DiagnosticCheck[];
  metrics?: {
    memoryTotal?: number;
    memoryAvailable?: number;
    diskAvailable?: number;
    diskTotal?: number;
    cpuPercent?: number;
    bootedAt?: number;
  };
};
export type MachineHealth = {
  id: string;
  name: string;
  os: "Windows" | "Linux";
  transport: "SSH" | "Local";
  remoteProvider?: "vnc" | "rdp";
  lastSeenAt?: number;
  stale: boolean;
  probe?: MachineProbe;
  busy: boolean;
  owner: "web" | "desktop";
  active: { web: number; external: number; unknown: number };
  projects: { id: string; name: string; remoteAvailable: boolean }[];
};
export type MachinesOverview = {
  machines: MachineHealth[];
  hub: { startedAt: number; hostStartedAt: number };
};
