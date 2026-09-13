import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { copyFile, readdir, rm } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import type { HubConfig } from "@codex-web/shared";
import { z } from "zod";
import { createSnapshot, restoreSnapshot, verifySnapshot } from "./maintenance.js";
import { Store } from "./store.js";

const manifestSchema = z
  .object({
    kind: z.literal("codex-web-team-backup"),
    format: z.literal(1),
    createdAt: z.string(),
    ownerId: z.string().uuid(),
    registryHash: z.string().regex(/^[a-f0-9]{64}$/),
    users: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            legacy: z.boolean(),
            initialized: z.boolean(),
            snapshot: z.string().nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(10),
  })
  .strict();
type Manifest = z.infer<typeof manifestSchema>;
const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
function directory(path: string) {
  if (resolve(path) !== path || dirname(path) === path) throw new Error("TEAM_BACKUP_PATH");
  let ancestor = path;
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  if (realpathSync(ancestor) !== ancestor) throw new Error("TEAM_BACKUP_PATH");
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (
    !lstatSync(path).isDirectory() ||
    lstatSync(path).isSymbolicLink() ||
    (lstatSync(path).mode & 0o077) !== 0
  )
    throw new Error("TEAM_BACKUP_PERMISSIONS");
}
function regular(path: string, limit = 1024 ** 3) {
  const info = lstatSync(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    realpathSync(path) !== resolve(path) ||
    info.size > limit
  )
    throw new Error("TEAM_BACKUP_FILE");
}
function ownership(db: DatabaseSync) {
  if (
    db.prepare("PRAGMA quick_check").get()?.quick_check !== "ok" ||
    db.prepare("PRAGMA foreign_key_check").all().length
  )
    throw new Error("TEAM_REGISTRY_INVALID");
  if (
    !["1", "2"].includes(
      String(db.prepare("SELECT value FROM team_meta WHERE key='schema'").get()?.value),
    )
  )
    throw new Error("TEAM_SCHEMA_UNSUPPORTED");
  const ownerId = z
    .string()
    .uuid()
    .parse(db.prepare("SELECT value FROM team_meta WHERE key='originalOwner'").get()?.value);
  const users = db
    .prepare(
      "SELECT u.id,u.legacy,n.initialized FROM team_users u LEFT JOIN team_namespaces n ON u.id=n.userId ORDER BY u.id",
    )
    .all()
    .map((user) => {
      if (user.initialized !== 0 && user.initialized !== 1)
        throw new Error("TEAM_NAMESPACE_MISSING");
      return {
        id: z.string().uuid().parse(user.id),
        legacy: user.legacy === 1,
        initialized: user.initialized === 1,
      };
    });
  if (
    !users.length ||
    users.length > 10 ||
    users.filter((u) => u.legacy).length !== 1 ||
    !users.find((u) => u.id === ownerId)?.legacy
  )
    throw new Error("TEAM_OWNER_MAPPING_INVALID");
  return { ownerId, users };
}
function mapping(db: DatabaseSync) {
  return JSON.stringify({
    ...ownership(db),
    runtimes: db.prepare("SELECT * FROM team_runtime_config ORDER BY userId").all(),
    enrollments: db
      .prepare("SELECT name FROM sqlite_master WHERE name='team_machine_enrollments'")
      .get()
      ? db
          .prepare(
            "SELECT id,ownerId,state,digest,machineId FROM team_machine_enrollments ORDER BY id",
          )
          .all()
      : [],
  });
}
function personalPaths(config: HubConfig, user: { id: string; legacy: boolean }): HubConfig {
  if (user.legacy) return { ...config, team: undefined };
  const root = join(config.team!.root, "users", user.id);
  return {
    ...config,
    team: undefined,
    machines: [],
    devices: [],
    projects: [],
    gpt: undefined,
    hub: { ...config.hub, databasePath: join(root, "app.db"), resultsPath: join(root, "results") },
  };
}
export async function createTeamSnapshot(
  config: HubConfig,
  destination: string,
  options: Parameters<typeof createSnapshot>[2] = {},
) {
  if (!config.team?.enabled) throw new Error("TEAM_DISABLED");
  const keep = options.keep ?? 7;
  if (!Number.isInteger(keep) || keep < 1 || keep > 100) throw new Error("TEAM_BACKUP_RETENTION");
  directory(destination);
  const sourcePath = join(config.team.root, "team.db");
  regular(sourcePath);
  const staging = join(destination, ".team-partial-" + randomUUID());
  directory(staging);
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    const before = mapping(source);
    await backup(source, join(staging, "team.db"));
    chmodSync(join(staging, "team.db"), 0o600);
    const registry = new DatabaseSync(join(staging, "team.db"));
    let identity: ReturnType<typeof ownership>;
    try {
      registry.exec("PRAGMA journal_mode=DELETE");
      identity = ownership(registry);
    } finally {
      registry.close();
    }
    const users: Manifest["users"] = [];
    for (const user of identity.users) {
      const selected = personalPaths(config, user);
      let snapshot: string | null = null;
      if (user.initialized) {
        regular(selected.hub.databasePath);
        const path = await createSnapshot(selected, join(staging, "users", user.id), {
          ...options,
          keep: 1,
          privateFiles: user.legacy ? options.privateFiles : [],
        });
        snapshot = relative(staging, path).split(sep).join("/");
      } else if (user.legacy) throw new Error("TEAM_OWNER_STORAGE_MISSING");
      users.push({ ...user, snapshot });
    }
    // Never publish a backup whose account-to-storage mapping changed halfway through copying.
    if (mapping(source) !== before) throw new Error("TEAM_OWNERSHIP_CHANGED_DURING_BACKUP");
    const manifest: Manifest = {
      kind: "codex-web-team-backup",
      format: 1,
      createdAt: new Date().toISOString(),
      ownerId: identity.ownerId,
      registryHash: digest(join(staging, "team.db")),
      users,
    };
    writeFileSync(join(staging, "team-manifest.json"), JSON.stringify(manifest, null, 2), {
      flag: "wx",
      mode: 0o600,
    });
    await verifyTeamSnapshot(staging);
    const completed = join(
      destination,
      "codex-team-backup-" + new Date().toISOString().replace(/[:.]/g, "-") + "-" + randomUUID(),
    );
    renameSync(staging, completed);
    // Only verified checkpoints of this installation are eligible. Stable named
    // checkpoints, unknown folders and another installation's snapshots remain intact.
    const candidates: string[] = [];
    for (const item of await readdir(destination, { withFileTypes: true })) {
      if (!item.isDirectory() || !/^codex-team-backup-[0-9TZ-]+-[a-f0-9-]{36}$/.test(item.name))
        continue;
      const path = join(destination, item.name);
      try {
        if ((await verifyTeamSnapshot(path)).ownerId === identity.ownerId) candidates.push(path);
      } catch {
        /* Never prune an unrecognized or damaged checkpoint. */
      }
    }
    candidates.sort().reverse();
    for (const path of candidates.slice(keep)) {
      if (dirname(path) !== destination || realpathSync(path) !== path)
        throw new Error("TEAM_BACKUP_RETENTION_PATH");
      await rm(path, { recursive: true });
    }
    return completed;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  } finally {
    source.close();
  }
}
export async function verifyTeamSnapshot(path: string) {
  regular(join(path, "team-manifest.json"), 32768);
  const manifest = manifestSchema.parse(
    JSON.parse(readFileSync(join(path, "team-manifest.json"), "utf8")),
  );
  regular(join(path, "team.db"));
  if (digest(join(path, "team.db")) !== manifest.registryHash)
    throw new Error("TEAM_REGISTRY_CHECKSUM");
  const db = new DatabaseSync(join(path, "team.db"), { readOnly: true });
  try {
    const actual = ownership(db);
    if (
      actual.ownerId !== manifest.ownerId ||
      JSON.stringify(actual.users) !==
        JSON.stringify(
          manifest.users.map(({ id, legacy, initialized }) => ({ id, legacy, initialized })),
        )
    )
      throw new Error("TEAM_OWNER_MAPPING_INVALID");
    for (const user of manifest.users) {
      if (!user.snapshot) {
        if (user.initialized || user.legacy) throw new Error("TEAM_USER_STORAGE_MISSING");
        continue;
      }
      if (
        !user.snapshot.startsWith(`users/${user.id}/codex-backup-`) ||
        user.snapshot.split("/").length !== 3 ||
        !/^codex-backup-[0-9TZ-]+-[a-f0-9-]{36}$/.test(user.snapshot.split("/")[2]!)
      )
        throw new Error("TEAM_SNAPSHOT_PATH");
      await verifySnapshot(join(path, user.snapshot));
    }
  } finally {
    db.close();
  }
  return manifest;
}
export function createTeamRecoveryLink(config: HubConfig, output: string) {
  if (!config.team?.enabled || resolve(output) !== output) throw new Error("TEAM_RECOVERY_PATH");
  directory(dirname(output));
  regular(join(config.team.root, "team.db"));
  const db = new DatabaseSync(join(config.team.root, "team.db"));
  try {
    const { ownerId } = ownership(db);
    const user = db.prepare("SELECT name,role,state FROM team_users WHERE id=?").get(ownerId)!;
    if (user.state !== "active") throw new Error("TEAM_OWNER_DISABLED");
    const token = randomBytes(32).toString("base64url"),
      id = randomUUID(),
      expires = Date.now() + 15 * 60000;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(
        "UPDATE team_invites SET state='revoked' WHERE kind='recovery' AND userId=? AND state='pending'",
      ).run(ownerId);
      db.prepare("INSERT INTO team_invites VALUES(?,?,'recovery',?,?,?, ?,?,'pending',?)").run(
        id,
        createHash("sha256").update(token).digest("hex"),
        ownerId,
        ownerId,
        String(user.name),
        String(user.role),
        expires,
        Date.now(),
      );
      db.prepare(
        "INSERT INTO team_audit(actorId,actorName,target,action,outcome,createdAt) VALUES(?,?,?,'recovery.host_issued','ok',?)",
      ).run(ownerId, String(user.name), ownerId, Date.now());
      writeFileSync(output, `${config.hub.publicBaseUrl}/#recover=${token}\n`, {
        mode: 0o600,
        flag: "wx",
      });
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return { path: output, expiresAt: new Date(expires).toISOString() };
  } finally {
    db.close();
  }
}
export async function restoreTeamSnapshot(snapshot: string, target: string) {
  const manifest = await verifyTeamSnapshot(snapshot);
  if (
    existsSync(target) ||
    resolve(target) !== target ||
    target.startsWith(resolve(snapshot) + sep)
  )
    throw new Error("TEAM_RESTORE_TARGET");
  directory(dirname(target));
  const staging = join(dirname(target), ".team-restore-" + randomUUID());
  directory(staging);
  try {
    directory(join(staging, "team"));
    await copyFile(join(snapshot, "team.db"), join(staging, "team", "team.db"));
    if (digest(join(staging, "team", "team.db")) !== manifest.registryHash)
      throw new Error("TEAM_REGISTRY_CHECKSUM");
    chmodSync(join(staging, "team", "team.db"), 0o600);
    for (const user of manifest.users) {
      const dest = user.legacy ? join(staging, "owner") : join(staging, "team", "users", user.id);
      if (user.snapshot) await restoreSnapshot(join(snapshot, user.snapshot), dest);
      else {
        directory(dest);
        new Store(join(dest, "app.db")).close();
        directory(join(dest, "results"));
      }
    }
    const registry = new DatabaseSync(join(staging, "team", "team.db"));
    try {
      registry.exec(
        "BEGIN IMMEDIATE; DELETE FROM team_sessions; UPDATE team_users SET revision=revision+1; UPDATE team_invites SET state='revoked' WHERE state='pending'; UPDATE team_receipts SET state='unknown' WHERE state='pending'; COMMIT;",
      );
      registry
        .prepare("INSERT OR REPLACE INTO team_meta(key,value) VALUES('nativeAdmission','blocked')")
        .run();
      if (
        registry
          .prepare("SELECT name FROM sqlite_master WHERE name='team_machine_enrollments'")
          .get()
      )
        registry
          .prepare(
            "UPDATE team_machine_enrollments SET state='revoked' WHERE state IN ('pending','reported')",
          )
          .run();
      ownership(registry);
    } finally {
      registry.close();
    }
    writeFileSync(
      join(staging, "restore.json"),
      JSON.stringify(
        {
          kind: "team-restore",
          ownerId: manifest.ownerId,
          sessionsRevoked: true,
          users: manifest.users.length,
          paths: {
            databasePath: join(target, "owner", "app.db"),
            resultsPath: join(target, "owner", "results"),
            teamRoot: join(target, "team"),
          },
          nativeConnectionsEnabled: false,
          createdAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      { mode: 0o600, flag: "wx" },
    );
    renameSync(staging, target);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}
