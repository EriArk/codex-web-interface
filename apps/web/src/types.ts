import type { Attachment, TurnSettings } from "@codex-web/shared";

export type { Attachment, Capabilities, ModelOption, TurnSettings } from "@codex-web/shared";
export type View = "chat" | "results" | "remote" | "activity";
export type { Theme } from "./theme";
export interface Session {
  authenticated: boolean;
  csrf: string;
  expires: number;
}
export interface Machine {
  id: string;
  name: string;
  type: "ssh-windows" | "local-linux";
  projectsDirectory: string;
  canCreateProjects?: boolean;
  desktopRestartAvailable?: boolean;
  remoteAvailable: boolean;
}
export interface Project {
  pinned?: boolean;
  archived?: boolean;
  deleted?: boolean;
  unassigned?: boolean;
  machineId?: string;
  workingDirectory?: string;
  roots?: string[];
  source?: string;
  threadCount?: number;
  id: string;
  name: string;
  machineName: string;
  remoteAvailable: boolean;
}
export interface Thread {
  pinned?: boolean;
  id: string;
  projectId: string;
  title: string;
  status: string;
  activeTurnId: string | null;
  settings?: TurnSettings;
  origin?: string;
  activitySource?: string;
  historyMode?: string;
  sourceUpdatedAt?: number;
}
export interface Message {
  id: string;
  turnId: string | null;
  role: string;
  phase: string;
  text: string;
  firstSeq: number;
  lastSeq: number;
  createdAt: string;
  attachments?: Attachment[];
  images?: { id: string; name: string; url: string }[];
}
export interface Question {
  id: string;
  question: string;
  header?: string;
  isSecret?: boolean;
  options: { label: string; description: string }[];
}
export interface Approval {
  id: string;
  threadId?: string;
  turnId?: string | null;
  kind: string;
  description: string;
  questions?: Question[];
  permissions?: unknown;
}
export interface HubEvent {
  type: string;
  seq?: number;
  threadId?: string;
  turnId?: string | null;
  payload?: Record<string, unknown>;
  createdAt?: string;
  thread?: Thread;
  approvals?: Approval[];
}
export interface History {
  sourceVersion?: number;
  contextTurn?: string;
  hasNewer?: boolean;
  messages: Message[];
  thread: Thread;
  approvals: Approval[];
  nextBefore: number | string | null;
  hasMore: boolean;
  lastSeq: number;
}
export type { ResultItem as Result } from "@codex-web/shared";
export interface Activity {
  seq: number;
  type: string;
  createdAt: string;
  payload: {
    command?: string;
    tool?: string;
    status?: string;
    exitCode?: number;
    output?: string;
    message?: string;
  };
}
