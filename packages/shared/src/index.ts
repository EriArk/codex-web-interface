import { z } from "zod";

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/);
const machine = z
  .object({
    id,
    name: z.string().min(1).max(120),
    type: z.enum(["local-linux", "ssh-windows"]),
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
      codexIdleTimeoutMinutes: z.number().int().min(1).max(1440).default(30),
      secureCookies: z.boolean().default(true),
    }),
    auth: z.object({ username: z.string().min(1).max(80).default("owner") }),
    machines: z.array(machine).max(20),
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
  warnings?: string[];
  threads: ThreadActivity[];
  projects: ProjectActivity[];
}
export const isActiveThread = (status: string): boolean =>
  ["starting", "running", "waiting_approval"].includes(status);
export const hasUnreadCompletion = (
  thread: Pick<ThreadActivity, "completedSeq" | "seenSeq">,
): boolean => thread.completedSeq > thread.seenSeq;
export function compareActivity(a: ProjectActivity, b: ProjectActivity): number {
  const rank = (p: ProjectActivity) => (p.active ? 0 : p.unread ? 1 : 2);
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

export const turnSettingsSchema = z
  .object({
    model: z.string().min(1).max(200),
    effort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]),
    mode: z.enum(["default", "plan"]),
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
