import { randomBytes } from "node:crypto";
import { type HubConfig, HubError } from "@codex-web/shared";
import { z } from "zod";
import type { TeamStore } from "./team-store.js";

const secret = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const teamGptRowSchema = z.object({
  userId: z.string().uuid(),
  slot: z.number().int().min(0).max(9),
  state: z.enum(["requested", "ready", "failed"]),
  serviceToken: secret,
  bridgeToken: secret,
  vncPassword: z.string().regex(/^[A-Za-z0-9_-]{8}$/),
  revision: z.number().int().positive(),
  code: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type TeamGptRow = z.infer<typeof teamGptRowSchema>;
export function teamGptName(userId: string) {
  return "codex-web-gpt-" + z.string().uuid().parse(userId);
}
export function nativeAdmissionBlocked(registry: TeamStore) {
  return (
    registry.db.prepare("SELECT value FROM team_meta WHERE key='nativeAdmission'").get()?.value ===
    "blocked"
  );
}
export class TeamGpt {
  constructor(
    readonly config: HubConfig,
    readonly registry: TeamStore,
  ) {}
  row(userId: string): TeamGptRow | undefined {
    const row = this.registry.db
      .prepare("SELECT * FROM team_gpt_profiles WHERE userId=?")
      .get(userId);
    return row ? teamGptRowSchema.parse(row) : undefined;
  }
  status(userId: string) {
    this.registry.active(userId);
    const legacy = userId === this.registry.ownerId && !!this.config.gpt,
      row = this.row(userId);
    return {
      enabled: !!this.config.team?.gptProfiles?.enabled,
      legacy,
      state: nativeAdmissionBlocked(this.registry)
        ? "blocked"
        : legacy
          ? "ready"
          : (row?.state ?? "absent"),
      ...(row ? { updatedAt: row.updatedAt, code: row.code } : {}),
    };
  }
  request(userId: string) {
    this.registry.active(userId);
    if (userId === this.registry.ownerId && this.config.gpt) return this.status(userId);
    const settings = this.config.team?.gptProfiles;
    if (!settings?.enabled || nativeAdmissionBlocked(this.registry))
      throw new HubError(
        503,
        "GPT_PROVISIONING_UNAVAILABLE",
        "Подготовка личных GPT-профилей пока не включена администратором сервера.",
      );
    this.registry.transaction(() => {
      const existing = this.row(userId);
      if (existing) {
        if (existing.state === "failed")
          this.registry.db
            .prepare(
              "UPDATE team_gpt_profiles SET state='requested',revision=revision+1,code=NULL,updatedAt=? WHERE userId=?",
            )
            .run(Date.now(), userId);
        return;
      }
      const slots = new Set(
        this.registry.db
          .prepare("SELECT slot FROM team_gpt_profiles")
          .all()
          .map((r) => Number(r.slot)),
      );
      if (slots.size + (this.config.gpt ? 1 : 0) >= settings.maxProfiles)
        throw new HubError(
          409,
          "GPT_PROFILE_LIMIT",
          "Лимит браузеров на сервере достигнут. Администратор может увеличить его после проверки ресурсов.",
        );
      let slot = 0;
      while (slots.has(slot)) slot++;
      const token = () => randomBytes(32).toString("base64url");
      this.registry.db
        .prepare("INSERT INTO team_gpt_profiles VALUES(?,?,'requested',?,?,?,1,NULL,?,?)")
        .run(
          userId,
          slot,
          token(),
          token(),
          randomBytes(6).toString("base64url"),
          Date.now(),
          Date.now(),
        );
      this.registry.audit(userId, "gpt.profile_requested", userId);
    });
    return this.status(userId);
  }
  runtime(userId: string): HubConfig["gpt"] {
    this.registry.active(userId);
    if (nativeAdmissionBlocked(this.registry)) return undefined;
    if (userId === this.registry.ownerId && this.config.gpt) return this.config.gpt;
    const row = this.row(userId),
      settings = this.config.team?.gptProfiles;
    if (!row || row.state !== "ready" || !settings?.enabled) return undefined;
    const tokenSecret = "GPT_TEAM_" + userId.replaceAll("-", "_").toUpperCase();
    // Hub-generated connector credential, never the person's native ChatGPT login.
    process.env[tokenSecret] = row.serviceToken;
    return { endpoint: `http://127.0.0.1:${settings.portBase + row.slot}/`, tokenSecret };
  }
  connection(userId: string) {
    this.registry.active(userId);
    if (nativeAdmissionBlocked(this.registry))
      throw new HubError(
        503,
        "RESTORE_ADMISSION_REQUIRED",
        "Подключения после восстановления ещё не проверены.",
      );
    if (userId === this.registry.ownerId && this.config.gpt)
      return { userId, legacy: true as const };
    const row = this.row(userId);
    if (!this.runtime(userId) || !row)
      throw new HubError(
        503,
        "GPT_PROFILE_NOT_READY",
        "Личный браузер ChatGPT ещё не подготовлен.",
      );
    // Only the owner-only engine socket returns this to the protected login gateway.
    return {
      userId,
      legacy: false as const,
      host: teamGptName(userId),
      password: row.vncPassword,
      gatewayPort: this.config.team!.gptProfiles!.portBase + 100 + row.slot,
    };
  }
}
