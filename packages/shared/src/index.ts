import { z } from "zod";
import { tailnetAddressSchema } from "./enrollment.js";

export * from "./appearance.js";
export * from "./elicitation.js";
export * from "./enrollment.js";
export * from "./gui-preview.js";
export * from "./relays.js";
export * from "./staging.js";
export * from "./team.js";

import { deviceConfigSchema } from "./devices.js";

export * from "./devices.js";

import { storagePolicySchema } from "./storage.js";

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/);
const machine = z
  .object({
    id,
    name: z.string().min(1).max(120),
    type: z.enum(["local-linux", "ssh-windows"]),
    // Omitted only for pre-team owner configurations. Enrollment always supplies roots.
    allowedProjectRoots: z.array(z.string().min(1).max(2048)).min(1).max(20).optional(),
    ssh: z
      .object({
        target: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.@-]{0,200}$/),
        configFile: z.string().startsWith("/").optional(),
      })
      .optional(),
    codex: z
      .object({
        command: z.string().min(1).max(1024).default("codex"),
        shell: z.enum(["powershell", "pwsh"]).default("powershell"),
        launcher: z.string().min(1).max(1024).optional(),
        activityNode: z.string().min(1).max(1024).optional(),
        desktopControl: z
          .string()
          .min(7)
          .max(1024)
          .refine(
            (value) =>
              /^[A-Za-z]:/.test(value) &&
              [47, 92].includes(value.charCodeAt(2)) &&
              value.toLowerCase().endsWith(".ps1") &&
              !Array.from(value).some((c) => [0, 10, 13].includes(c.charCodeAt(0))),
          )
          .optional(),
      })
      .default({ command: "codex", shell: "powershell" }),
    remote: z
      .object({
        provider: z.enum(["vnc", "rdp"]),
        host: z.string().min(1).max(253),
        port: z.number().int().min(1).max(65535),
        username: z.string().optional(),
        passwordSecret: z
          .string()
          .regex(/^[A-Z][A-Z0-9_]*$/)
          .optional(),
      })
      .optional(),
  })
  .superRefine((m, ctx) => {
    if (m.type === "ssh-windows" && !m.ssh)
      ctx.addIssue({
        code: "custom",
        message: "SSH machine requires an SSH target",
        path: ["ssh"],
      });
  });
export const configSchema = z
  .object({
    hub: z.object({
      publicBaseUrl: z.url(),
      host: z.string().default("127.0.0.1"),
      port: z.number().int().min(1).max(65535).default(8780),
      databasePath: z.string().min(1),
      resultsPath: z.string().min(1),
      speechSocket: z.string().startsWith("/").max(200).optional(),
      codexIdleTimeoutMinutes: z.number().int().min(1).max(1440).default(30),
      secureCookies: z.boolean().default(true),
      storage: storagePolicySchema,
    }),
    gpt: z
      .object({
        endpoint: z.url().refine((value) => {
          const url = new URL(value);
          return (
            url.protocol === "http:" &&
            ["127.0.0.1", "localhost", "gpt", "codex-web-gpt-connect"].includes(url.hostname) &&
            !url.username &&
            !url.password &&
            url.pathname === "/" &&
            !url.search &&
            !url.hash
          );
        }),
        tokenSecret: z
          .string()
          .regex(/^[A-Z][A-Z0-9_]*$/)
          .default("GPT_SERVICE_TOKEN"),
      })
      .optional(),
    auth: z.object({ username: z.string().min(1).max(80).default("owner") }),
    team: z
      .object({
        enabled: z.boolean().default(false),
        root: z.string().startsWith("/").max(2000),
        maxUsers: z.number().int().min(2).max(10).default(10),
        hubTailnetAddress: tailnetAddressSchema.optional(),
        gptProfiles: z
          .object({
            enabled: z.boolean().default(false),
            maxProfiles: z.number().int().min(1).max(10).default(2),
            portBase: z.number().int().min(8900).max(65000).default(8900),
          })
          .optional(),
      })
      .optional(),
    machines: z.array(machine).max(20),
    devices: z.array(deviceConfigSchema).max(40).default([]),
    projects: z
      .array(
        z.object({
          id,
          name: z.string().min(1).max(120),
          machineId: id,
          workingDirectory: z.string().min(1).max(2048),
          enabled: z.boolean().default(true),
        }),
      )
      .max(200),
  })
  .superRefine((c, ctx) => {
    const machines = new Map(c.machines.map((m) => [m.id, m]));
    if (new Set(c.devices.map((d) => d.id)).size !== c.devices.length)
      ctx.addIssue({ code: "custom", message: "Duplicate device ID" });
    if (machines.size !== c.machines.length)
      ctx.addIssue({ code: "custom", message: "Duplicate machine ID" });
    if (new Set(c.projects.map((p) => p.id)).size !== c.projects.length)
      ctx.addIssue({ code: "custom", message: "Duplicate project ID" });
    for (const p of c.projects) {
      const m = machines.get(p.machineId);
      if (!m) ctx.addIssue({ code: "custom", message: "Unknown project machine" });
      else if (
        m.type === "local-linux"
          ? !p.workingDirectory.startsWith("/")
          : !/^(?:[A-Za-z]:[\\/]|\\\\)/.test(p.workingDirectory)
      ) {
        ctx.addIssue({
          code: "custom",
          message: "Project working directory must be absolute for its target OS",
        });
      }
    }
    const url = new URL(c.hub.publicBaseUrl);
    if (url.origin !== c.hub.publicBaseUrl.replace(/\/$/, ""))
      ctx.addIssue({ code: "custom", message: "Public URL must be an origin without a path" });
    if (c.hub.secureCookies && url.protocol !== "https:")
      ctx.addIssue({ code: "custom", message: "Secure cookies require an HTTPS public URL" });
    if (!c.hub.secureCookies && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
      ctx.addIssue({
        code: "custom",
        message: "Insecure cookies are only allowed for loopback development",
      });
  });
export type HubConfig = z.infer<typeof configSchema>;
export type MachineConfig = HubConfig["machines"][number];
export type ProjectConfig = HubConfig["projects"][number];
export interface ThreadActivity {
  id: string;
  projectId: string;
  title: string;
  status: string;
  activeTurnId: string | null;
  updatedAt: string;
  activityAt: string | null;
  completedSeq: number;
  seenSeq: number;
  completedTurnId: string | null;
  completedStatus: string | null;
  activitySource?: string;
}
export interface ProjectActivity {
  id: string;
  active: number;
  unread: number;
  waiting: number;
  updatedAt: string;
  activityAt: string;
}
export interface NavigationState {
  library?: {
    id: string;
    kind: "thread" | "project";
    name?: string;
    pinned?: boolean;
    archived?: boolean;
    deleted?: boolean;
  }[];
  warnings?: string[];
  threads: ThreadActivity[];
  projects: ProjectActivity[];
}
export const isActiveThread = (status: string): boolean =>
  ["starting", "running", "waiting_approval"].includes(status);
export const hasUnreadCompletion = (
  thread: Pick<ThreadActivity, "completedSeq" | "seenSeq"> &
    Partial<Pick<ThreadActivity, "status">>,
): boolean => !isActiveThread(thread.status ?? "") && thread.completedSeq > thread.seenSeq;
export function compareActivity(a: ProjectActivity, b: ProjectActivity): number {
  const rank = (p: ProjectActivity) => (p.active ? 0 : 1);
  return (
    rank(a) - rank(b) ||
    (a.active && b.active
      ? b.activityAt.localeCompare(a.activityAt)
      : b.updatedAt.localeCompare(a.updatedAt)) ||
    a.id.localeCompare(b.id)
  );
}
export function compareThreadActivity(a: ThreadActivity, b: ThreadActivity): number {
  const activity = (t: ThreadActivity): ProjectActivity => ({
    id: t.id,
    active: Number(isActiveThread(t.status)),
    unread: Number(hasUnreadCompletion(t)),
    waiting: Number(t.status === "waiting_approval"),
    updatedAt: t.updatedAt,
    activityAt: t.activityAt ?? t.updatedAt,
  });
  return compareActivity(activity(a), activity(b));
}

export interface HubEvent {
  seq: number;
  threadId: string;
  turnId: string | null;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}
export class HubError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/** The user message has not reached Codex; an explicit retry is safe. */
export class NotSubmittedError extends HubError {
  constructor(error: unknown) {
    super(
      error instanceof HubError ? error.statusCode : 500,
      error instanceof HubError ? error.code : "PREPARATION_FAILED",
      error instanceof HubError
        ? error.message
        : "Не удалось подготовить сообщение. Попробуй снова.",
    );
  }
}

export const turnSettingsSchema = z
  .object({
    model: z.string().min(1).max(200),
    effort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]),
    mode: z.enum(["default", "plan"]),
    access: z.enum(["workspace", "full"]).optional(),
  })
  .strict();
export type TurnSettings = z.infer<typeof turnSettingsSchema>;
export interface ModelOption {
  id: string;
  name: string;
  description: string;
  efforts: TurnSettings["effort"][];
  defaultEffort: TurnSettings["effort"];
  supportsImages: boolean;
}
export interface Capabilities {
  accessModes?: ("workspace" | "full")[];
  accessMessage?: string;
  serverVersion?: string;
  warnings?: string[];
  models: ModelOption[];
  modes: TurnSettings["mode"][];
  defaults: TurnSettings;
}
export interface Attachment {
  id: string;
  threadId: string;
  name: string;
  mime: string;
  bytes: number;
  image: boolean;
  url: string;
  previewUrl?: string;
  messageId: string | null;
  createdAt: string;
}

export * from "./delivery.js";
export type {
  GptConversation,
  GptFile,
  GptHistoryPage,
  GptJob,
  GptMessage,
  GptModels,
  GptProgress,
  GptProject,
} from "./gpt.js";
export * from "./gpt-connection.js";
export * from "./gpt-operations.js";
export * from "./gpt-project.js";
export type {
  InspectRequest,
  ProjectDiff,
  ProjectDirectory,
  ProjectFileEntry,
  ProjectGit,
  ProjectReleases,
  ProjectRepository,
} from "./inspector.js";
export type {
  DiagnosticCheck,
  MachineHealth,
  MachineProbe,
  MachinesOverview,
} from "./machineHealth.js";
export * from "./native-work.js";
export * from "./native-workspace.js";
export type {
  NotebookLink,
  NotebookPin,
  NotebookScope,
  NotebookTarget,
  NoteCapture,
  NoteRecord,
  NoteSource,
  NoteSummary,
  NotesPage,
  NoteWrite,
} from "./notebook.js";
export {
  notebookScopeSchema,
  notebookTargetSchema,
  noteCaptureSchema,
  noteWriteSchema,
} from "./notebook.js";
export type {
  CachedProjectGit,
  OverviewResult,
  OverviewThread,
  ProjectOverview,
} from "./overview.js";
export * from "./plan-reconciliation.js";
export * from "./project-core.js";
export * from "./project-work.js";
export * from "./quick-capture.js";
export * from "./results.js";
export type {
  ProjectSetupInput,
  ProjectSetupOperation,
  SetupInspection,
  SetupMachineReceipt,
  SetupProbeRequest,
  SetupProbeResult,
  SetupRepository,
} from "./setup.js";
export * from "./storage.js";
export {
  type TaskFields,
  type TaskProject,
  type TaskProjectsPage,
  type TaskRecord,
  type TaskSummary,
  type TasksPage,
  type TaskWrite,
  taskDueSchema,
  taskFieldsSchema,
  taskStatusSchema,
  taskWriteSchema,
} from "./tasks.js";
export * from "./usage.js";
export * from "./work-review.js";
