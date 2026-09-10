export type ProjectSetupInput = {
  machineId: string;
  name: string;
  workingDirectory: string;
  createDirectory: boolean;
  repository: {
    mode: "none" | "create" | "connect";
    owner: string;
    name: string;
    visibility: "private" | "public";
    description: string;
  };
};
export type SetupRepository = {
  id: number;
  owner: string;
  name: string;
  url: string;
  private: boolean;
  empty: boolean;
  createdAt: string;
  description: string;
};
export type SetupInspection = {
  exists: boolean;
  empty: boolean;
  git: boolean;
  branch: string;
  head: string;
  origin: string;
  dirty: boolean;
  login?: string;
  remote?: SetupRepository;
  fingerprint: string;
  steps: string[];
};
export type SetupMachineReceipt = {
  id: string;
  state: "running" | "unknown" | "complete";
  phase: string;
  startedAt: number;
  updatedAt: number;
  error?: string;
  repository?: SetupRepository;
};
export type SetupProbeRequest =
  | { op: "repositories"; search: string; page: number }
  | { op: "inspect"; input: ProjectSetupInput }
  | { op: "apply"; input: ProjectSetupInput; id: string; fingerprint: string }
  | { op: "status"; id: string };
export type SetupProbeResult =
  | { login: string; repositories: SetupRepository[]; hasMore: boolean }
  | SetupInspection
  | SetupMachineReceipt
  | null;
export type ProjectSetupOperation = {
  id: string;
  input: ProjectSetupInput;
  inspection: SetupInspection;
  state: "prepared" | "running" | "unknown" | "failed" | "complete";
  phase: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
  project?: { id: string; name: string; machineId: string; workingDirectory: string };
};
