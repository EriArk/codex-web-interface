import type { TurnSettings } from "./index.js";
export type IntakeSource = { key: string; title: string; url: string; repositoryId: number };
export type IntakeState = {
  projectId: string;
  name: string;
  revision: number;
  threadId: string | null;
  status: string;
  creationUnknown: boolean;
  messages: { id: string; turnId: string | null; role: string; text: string }[];
  before: string | number | null;
  requests: { id: string; text: string; sources: IntakeSource[]; state: string }[];
  settings?: TurnSettings;
  approvals: Record<string, unknown>[];
};
