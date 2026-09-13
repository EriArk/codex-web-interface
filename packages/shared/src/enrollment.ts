import { z } from "zod";

// Enrollment never accepts DNS names, public endpoints or caller SSH options.
export const tailnetAddressSchema = z.string().refine((value) => {
  if (!/^100\.(?:0|[1-9]\d{0,2})\.(?:0|[1-9]\d{0,2})\.(?:0|[1-9]\d{0,2})$/.test(value))
    return false;
  const parts = value.split(".").map(Number);
  return parts[1]! >= 64 && parts[1]! <= 127 && parts.slice(2).every((n) => n <= 255);
});
export const machineEnrollmentReportSchema = z
  .object({
    version: z.literal(1),
    address: tailnetAddressSchema,
    hostKey: z.string().regex(/^ssh-ed25519 [A-Za-z0-9+/]{68}$/),
    machineGuid: z.string().uuid(),
    sid: z.string().regex(/^S-1-5-21-\d{1,10}-\d{1,10}-\d{1,10}-\d{1,10}$/),
    username: z
      .string()
      .regex(/^[\p{L}\p{N}_][\p{L}\p{N}_. -]{0,63}$/u)
      .refine((value) => value === value.trim() && !value.endsWith(".")),
    profile: z.string().min(4).max(240),
    roots: z.array(z.string().min(3).max(500)).min(1).max(20),
    readiness: z
      .object({
        companion: z.boolean(),
        codex: z.boolean(),
        node: z.boolean(),
        git: z.boolean(),
        github: z.boolean(),
        desktop: z.boolean(),
      })
      .strict(),
  })
  .strict();
export type MachineEnrollmentReport = z.infer<typeof machineEnrollmentReportSchema>;
export interface MachineEnrollment {
  id: string;
  ownerId: string;
  ownerName: string;
  name: string;
  state: "pending" | "reported" | "approved" | "revoked" | "expired";
  createdAt: number;
  expires: number;
  fingerprint?: string;
  address?: string;
  roots?: string[];
  readiness?: MachineEnrollmentReport["readiness"];
  machineId?: string;
}
