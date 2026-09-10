import { z } from "zod";

export const deviceConfigSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/),
  name: z.string().min(1).max(120),
  platform: z.enum(["linux", "windows", "android"]),
  ssh: z.object({
    target: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.@-]{0,200}$/),
    configFile: z.string().startsWith("/").max(1024),
  }),
  shell: z.enum(["powershell", "pwsh"]).default("powershell"),
  power: z.boolean().default(false),
  mounts: z.boolean().default(false),
});
export type DeviceConfig = z.infer<typeof deviceConfigSchema>;
export type DeviceInfo = Pick<DeviceConfig, "id" | "name" | "platform" | "power" | "mounts">;
export interface DeviceSnapshot {
  checkedAt: number;
  online: boolean;
  error?: string;
  hostname?: string;
  os?: string;
  architecture?: string;
  cpu?: string;
  cores?: number;
  cpuPercent?: number;
  load1?: number;
  uptimeSeconds?: number;
  memoryTotal?: number;
  memoryAvailable?: number;
  disks: { name: string; mount: string; total: number; available: number; filesystem?: string }[];
  temperatures: { name: string; celsius: number }[];
}
export interface DeviceTerminalInfo {
  id: string;
  deviceId: string;
  title: string;
  state: "open" | "closed";
  createdAt: string;
  exitCode: number | null;
}
export const deviceActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("shell") }).strict(),
  z.object({ kind: z.enum(["restart", "shutdown"]), confirmation: z.string().max(120) }).strict(),
  z
    .object({
      kind: z.literal("mount"),
      protocol: z.enum(["smb", "nfs"]),
      source: z
        .string()
        .min(3)
        .max(512)
        .refine(
          (value) =>
            !Array.from(value).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127),
        ),
      name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/),
      credentials: z.boolean().default(false),
      confirmation: z.string().max(120),
    })
    .strict(),
]);
export type DeviceAction = z.infer<typeof deviceActionSchema>;
