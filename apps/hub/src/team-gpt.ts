import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { NativeGptReadClient } from "./gpt-native.js";
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
      native: legacy
        ? !!this.config.nativeGpt
        : this.config.team?.gptProfiles?.runtime === "native",
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
    if (this.config.team?.gptProfiles?.runtime === "native") return undefined;
    const row = this.row(userId),
      settings = this.config.team?.gptProfiles;
    if (!row || row.state !== "ready" || !settings?.enabled) return undefined;
    const tokenSecret = "GPT_TEAM_" + userId.replaceAll("-", "_").toUpperCase();
    // Hub-generated connector credential, never the person's native ChatGPT login.
    process.env[tokenSecret] = row.serviceToken;
    return { endpoint: `http://127.0.0.1:${settings.portBase + row.slot}/`, tokenSecret };
  }
  nativeSocket(userId: string) {
    this.registry.active(userId);
    if (
      !this.config.team?.gptProfiles?.enabled ||
      this.config.team.gptProfiles.runtime !== "native" ||
      this.row(userId)?.state !== "ready" ||
      nativeAdmissionBlocked(this.registry)
    )
      throw new HubError(409, "GPT_PROFILE_NOT_READY", "Личный клиент ещё не готов.");
    return join(this.config.team.root, "users", userId, "gpt", "native-adapter", "adapter.sock");
  }
  nativeRuntime(userId: string): HubConfig["nativeGpt"] {
    this.registry.active(userId);
    if (nativeAdmissionBlocked(this.registry)) return undefined;
    if (userId === this.registry.ownerId)
      return this.config.nativeGpt?.userId === userId ? this.config.nativeGpt : undefined;
    if (
      this.config.team?.gptProfiles?.runtime !== "native" ||
      !this.config.team.gptProfiles.enabled ||
      this.row(userId)?.state !== "ready"
    )
      return undefined;
    const socketPath = this.nativeSocket(userId),
      path = join(socketPath, "..", "binding.json");
    if (!existsSync(path)) return undefined;
    const stat = lstatSync(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.mode & 0o077 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw Error("NATIVE_INVALID_BINDING");
    const binding = z
      .object({
        build: z.literal("26.915.31945"),
        userId: z.literal(userId),
        accountFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .parse(JSON.parse(readFileSync(path, "utf8")));
    return { userId, socketPath, accountFingerprint: binding.accountFingerprint };
  }
  async activate(userId: string) {
    if (userId === this.registry.ownerId || this.config.team?.gptProfiles?.runtime !== "native")
      return;
    const client = new NativeGptReadClient(
      { userId, socketPath: this.nativeSocket(userId) },
      () => {
        this.registry.active(userId);
        if (nativeAdmissionBlocked(this.registry)) throw Error("RESTORE_ADMISSION_REQUIRED");
      },
    );
    try {
      await client.activate();
    } catch {
      throw new HubError(
        409,
        "GPT_LOGIN_REQUIRED",
        "Сначала войди в свой аккаунт в клиенте ChatGPT, затем нажми «Активировать».",
      );
    }
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
    if (!row || row.state !== "ready" || !this.config.team?.gptProfiles?.enabled)
      throw new HubError(
        503,
        "GPT_PROFILE_NOT_READY",
        "Личный браузер ChatGPT ещё не подготовлен.",
      );
    // Only the owner-only engine socket returns this to the protected login gateway.
    return {
      userId,
      legacy: false as const,
      native: this.config.team?.gptProfiles?.runtime === "native",
      host: teamGptName(userId),
      password: row.vncPassword,
      gatewayPort: this.config.team!.gptProfiles!.portBase + 100 + row.slot,
    };
  }
}
