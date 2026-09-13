import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import type { HubConfig } from "@codex-web/shared";
import { z } from "zod";
import { hostLock } from "./host-lock.js";
import { teamGptRowSchema } from "./team-gpt.js";

const exec = promisify(execFile);
const entrySchema = z
  .object({
    path: z.string().min(1).max(2048),
    bytes: z
      .number()
      .int()
      .min(0)
      .max(1024 ** 3),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const manifestSchema = z
  .object({
    kind: z.literal("codex-web-gpt-profiles"),
    format: z.literal(1),
    createdAt: z.string(),
    ownerId: z.string().uuid(),
    identity: z.string().regex(/^[a-f0-9]{64}$/),
    profiles: z
      .array(
        z
          .object({
            userId: z.string().uuid(),
            legacy: z.boolean(),
            files: z.array(entrySchema).max(100000),
          })
          .strict(),
      )
      .max(10),
  })
  .strict();
type Entry = z.infer<typeof entrySchema>;
type Manifest = z.infer<typeof manifestSchema>;
type Profile = { userId: string; legacy: boolean; path: string; keys?: Record<string, string> };
type Options = { legacyProfile?: string; run?: (args: string[]) => Promise<string> };
const excluded = new Set([
  "browser.lock",
  "profile/SingletonLock",
  "profile/SingletonCookie",
  "profile/SingletonSocket",
]);
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return !!rel && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep);
};
async function directory(path: string, create = false) {
  if (!isAbsolute(path) || resolve(path) !== path || dirname(path) === path)
    throw Error("PROFILE_BACKUP_PATH");
  // Check existing parents before creating through them.
  let ancestor = path;
  for (;;) {
    try {
      await lstat(ancestor);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      ancestor = dirname(ancestor);
    }
  }
  if ((await realpath(ancestor)) !== ancestor) throw Error("PROFILE_BACKUP_PATH");
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (await realpath(path)) !== path ||
    stat.mode & 0o077 ||
    stat.uid !== process.getuid?.()
  )
    throw Error("PROFILE_BACKUP_PERMISSIONS");
}
function validPath(path: string) {
  if (
    !path ||
    path.length > 2048 ||
    path.split("/").length > 40 ||
    path.includes("\\") ||
    [...path].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw Error("PROFILE_BACKUP_FILE");
}
async function tree(root: string, prefix = "", found: string[] = []): Promise<string[]> {
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    validPath(path);
    if (excluded.has(path)) continue;
    if (entry.isSymbolicLink()) throw Error("PROFILE_BACKUP_LINK");
    if (entry.isDirectory()) await tree(root, path, found);
    else if (entry.isFile()) found.push(path);
    else throw Error("PROFILE_BACKUP_FILE");
    if (found.length > 100000) throw Error("PROFILE_BACKUP_LIMIT");
  }
  return found.sort();
}
async function copyAndDigest(root: string, path: string, destination?: string): Promise<Entry> {
  validPath(path);
  const input = join(root, path);
  if (!inside(root, input) || (await realpath(input)) !== input) throw Error("PROFILE_BACKUP_FILE");
  const file = await open(input, constants.O_RDONLY | constants.O_NOFOLLOW);
  let output: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 ** 3)
      throw Error("PROFILE_BACKUP_FILE");
    if (destination) {
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      output = await open(destination, "wx", 0o600);
    }
    const digest = createHash("sha256"),
      buffer = Buffer.alloc(65536);
    let bytes = 0;
    for (;;) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      bytes += bytesRead;
      if (bytes > stat.size) throw Error("PROFILE_CHANGED_DURING_BACKUP");
      digest.update(buffer.subarray(0, bytesRead));
      if (output) {
        let offset = 0;
        while (offset < bytesRead) {
          const written = await output.write(buffer, offset, bytesRead - offset, null);
          if (!written.bytesWritten) throw Error("PROFILE_BACKUP_WRITE");
          offset += written.bytesWritten;
        }
      }
    }
    const after = await file.stat();
    if (bytes !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs)
      throw Error("PROFILE_CHANGED_DURING_BACKUP");
    if (output) await output.sync();
    return { path, bytes, sha256: digest.digest("hex") };
  } finally {
    await output?.close();
    await file.close();
  }
}
export function profileIdentity(db: DatabaseSync, legacy: boolean) {
  if (
    db.prepare("PRAGMA quick_check").get()?.quick_check !== "ok" ||
    db.prepare("PRAGMA foreign_key_check").all().length
  )
    throw Error("PROFILE_REGISTRY_INVALID");
  const ownerId = z
    .string()
    .uuid()
    .parse(db.prepare("SELECT value FROM team_meta WHERE key='originalOwner'").get()?.value);
  const users = db.prepare("SELECT id,legacy FROM team_users ORDER BY id").all();
  if (
    users.filter((u) => u.legacy === 1).length !== 1 ||
    !users.find((u) => u.id === ownerId && u.legacy === 1)
  )
    throw Error("PROFILE_OWNER_MAPPING");
  const rows = db
    .prepare("SELECT * FROM team_gpt_profiles ORDER BY userId")
    .all()
    .map((row) => teamGptRowSchema.parse(row));
  if (
    rows.some((row) => !users.some((user) => user.id === row.userId)) ||
    (legacy && rows.some((row) => row.userId === ownerId))
  )
    throw Error("PROFILE_OWNER_MAPPING");
  return {
    ownerId,
    rows,
    identity: hash(
      JSON.stringify({
        ownerId,
        legacy,
        profiles: rows.map(({ userId, slot, serviceToken, bridgeToken, vncPassword }) => ({
          userId,
          slot,
          serviceToken,
          bridgeToken,
          vncPassword,
        })),
      }),
    ),
  };
}
function profiles(config: HubConfig, db: DatabaseSync, options: Options) {
  if (!config.team?.enabled) throw Error("TEAM_DISABLED");
  const legacy = !!config.gpt;
  if (legacy !== !!options.legacyProfile) throw Error("LEGACY_PROFILE_MAPPING_REQUIRED");
  const identity = profileIdentity(db, legacy);
  const entries: Profile[] = identity.rows.map((row) => ({
    userId: row.userId,
    legacy: false,
    path: join(config.team!.root, "users", row.userId, "gpt"),
    keys: {
      "service-token": row.serviceToken,
      "bridge-token": row.bridgeToken,
      "vnc-password": row.vncPassword,
    },
  }));
  if (legacy)
    entries.unshift({
      userId: identity.ownerId,
      legacy: true,
      path: resolve(options.legacyProfile!),
    });
  return { ...identity, entries };
}
async function stopped(entries: Profile[], run: NonNullable<Options["run"]>) {
  const ids = (await run(["container", "ls", "-a", "--format", "{{.ID}}"]))
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
  if (ids.length > 1000 || ids.some((id) => !/^[a-f0-9]{12,64}$/.test(id)))
    throw Error("PROFILE_DOCKER_INSPECTION");
  const containers = ids.length ? JSON.parse(await run(["container", "inspect", ...ids])) : [];
  if (!Array.isArray(containers) || containers.length !== ids.length)
    throw Error("PROFILE_DOCKER_INSPECTION");
  for (const entry of entries) {
    let bound = false;
    for (const container of containers) {
      for (const mount of container.Mounts ?? []) {
        if (mount.Type !== "bind" || typeof mount.Source !== "string") continue;
        const root = resolve(mount.Source);
        if (root === entry.path || inside(root, entry.path) || inside(entry.path, root)) {
          if (
            container.State?.Running ||
            container.State?.Restarting ||
            container.State?.Paused ||
            !["exited", "created", "dead"].includes(container.State?.Status)
          )
            throw Error("PROFILE_BROWSER_MUST_BE_STOPPED");
          if (root === entry.path && mount.Destination === "/data") bound = true;
        }
      }
    }
    if (!bound) throw Error("PROFILE_CONTAINER_MAPPING_MISSING");
  }
}
const docker = async (args: string[]) =>
  (await exec("docker", args, { timeout: 15000, maxBuffer: 8 * 1024 ** 2, windowsHide: true }))
    .stdout;
/** No browser stop/start and no credential output. Operator first quiesces the engine and browsers. */
export async function createProfileSnapshot(
  config: HubConfig,
  destination: string,
  options: Options = {},
) {
  if (!config.team?.enabled) throw Error("TEAM_DISABLED");
  await directory(config.team.root);
  const guard = await hostLock(join(config.team.root, "gpt-host.lock"));
  let db: DatabaseSync | undefined;
  const locks: Awaited<ReturnType<typeof hostLock>>[] = [];
  let staging: string | undefined;
  try {
    db = new DatabaseSync(join(config.team.root, "team.db"), { readOnly: true });
    const mapping = profiles(config, db, options);
    if (
      mapping.entries.some(
        (e) => destination === e.path || inside(e.path, destination) || inside(destination, e.path),
      )
    )
      throw Error("PROFILE_BACKUP_PATH");
    await directory(destination, true);
    const assertMapping = () => {
      if (profiles(config, db!, options).identity !== mapping.identity)
        throw Error("PROFILE_OWNER_MAPPING_CHANGED");
    };
    await stopped(mapping.entries, options.run ?? docker);
    for (const entry of mapping.entries) {
      await directory(entry.path);
      locks.push(await hostLock(join(entry.path, "browser.lock")));
      for (const [name, value] of Object.entries(entry.keys ?? {})) {
        const file = await open(join(entry.path, name), constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          if ((await file.stat()).size > 128 || (await file.readFile("utf8")) !== value)
            throw Error("PROFILE_CONNECTOR_MAPPING");
        } finally {
          await file.close();
        }
      }
    }
    staging = join(destination, ".profile-partial-" + randomUUID());
    await directory(staging, true);
    const manifest: Manifest = {
      kind: "codex-web-gpt-profiles",
      format: 1,
      createdAt: new Date().toISOString(),
      ownerId: mapping.ownerId,
      identity: mapping.identity,
      profiles: [],
    };
    let total = 0;
    for (const entry of mapping.entries) {
      const paths = await tree(entry.path),
        files: Entry[] = [];
      for (const path of paths) {
        await guard.check();
        for (const lock of locks) await lock.check();
        const copied = await copyAndDigest(entry.path, path, join(staging, entry.userId, path));
        total += copied.bytes;
        if (total > 20 * 1024 ** 3) throw Error("PROFILE_BACKUP_LIMIT");
        files.push(copied);
      }
      if (JSON.stringify(await tree(entry.path)) !== JSON.stringify(paths))
        throw Error("PROFILE_CHANGED_DURING_BACKUP");
      manifest.profiles.push({ userId: entry.userId, legacy: entry.legacy, files });
    }
    assertMapping();
    await stopped(mapping.entries, options.run ?? docker);
    assertMapping();
    await writeFile(join(staging, "profiles.json"), JSON.stringify(manifest, null, 2), {
      flag: "wx",
      mode: 0o600,
    });
    await verifyProfileSnapshot(staging);
    await guard.check();
    for (const lock of locks) await lock.check();
    assertMapping();
    const completed = join(destination, "codex-gpt-backup-" + randomUUID());
    await rename(staging, completed);
    staging = undefined;
    return completed;
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true });
    for (const lock of locks.reverse()) await lock.close();
    db?.close();
    await guard.close();
  }
}
export async function verifyProfileSnapshot(path: string): Promise<Manifest> {
  await directory(path);
  const file = await open(join(path, "profiles.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
  let manifest: Manifest;
  try {
    if ((await file.stat()).size > 32 * 1024 ** 2) throw Error("PROFILE_BACKUP_MANIFEST");
    manifest = manifestSchema.parse(JSON.parse(await file.readFile("utf8")));
  } finally {
    await file.close();
  }
  if (
    new Set(manifest.profiles.map((p) => p.userId)).size !== manifest.profiles.length ||
    manifest.profiles.filter((p) => p.legacy).some((p) => p.userId !== manifest.ownerId)
  )
    throw Error("PROFILE_OWNER_MAPPING");
  const expected = ["profiles.json"];
  let bytes = 0;
  for (const profile of manifest.profiles) {
    if (new Set(profile.files.map((f) => f.path)).size !== profile.files.length)
      throw Error("PROFILE_BACKUP_MANIFEST");
    for (const entry of profile.files) {
      validPath(entry.path);
      if (excluded.has(entry.path)) throw Error("PROFILE_BACKUP_MANIFEST");
      expected.push(`${profile.userId}/${entry.path}`);
      const actual = await copyAndDigest(join(path, profile.userId), entry.path);
      if (actual.bytes !== entry.bytes || actual.sha256 !== entry.sha256)
        throw Error("PROFILE_BACKUP_CHECKSUM");
      bytes += actual.bytes;
      if (bytes > 20 * 1024 ** 3) throw Error("PROFILE_BACKUP_LIMIT");
    }
  }
  if (JSON.stringify((await tree(path)).sort()) !== JSON.stringify(expected.sort()))
    throw Error("PROFILE_BACKUP_UNEXPECTED_FILE");
  return manifest;
}
/** Restore only alongside an already blocked, identity-matching team restore, never over live data. */
export async function restoreProfileSnapshot(snapshot: string, restoredTeamRoot: string) {
  const manifest = await verifyProfileSnapshot(snapshot);
  await directory(restoredTeamRoot);
  const guard = await hostLock(join(restoredTeamRoot, "gpt-host.lock"));
  let db: DatabaseSync | undefined;
  const staging = join(restoredTeamRoot, ".profile-restore-" + randomUUID());
  try {
    db = new DatabaseSync(join(restoredTeamRoot, "team.db"), { readOnly: true });
    if (
      db.prepare("SELECT value FROM team_meta WHERE key='nativeAdmission'").get()?.value !==
      "blocked"
    )
      throw Error("RESTORE_ADMISSION_REQUIRED");
    const mapping = profileIdentity(
      db,
      manifest.profiles.some((p) => p.legacy),
    );
    if (mapping.ownerId !== manifest.ownerId || mapping.identity !== manifest.identity)
      throw Error("PROFILE_OWNER_MAPPING");
    const expected = [
      ...mapping.rows.map((r) => r.userId),
      ...(manifest.profiles.some((p) => p.legacy) ? [mapping.ownerId] : []),
    ].sort();
    if (JSON.stringify(expected) !== JSON.stringify(manifest.profiles.map((p) => p.userId).sort()))
      throw Error("PROFILE_OWNER_MAPPING");
    // One atomic directory publication. Host preparation must use this staged set during readmission;
    // it is deliberately not installed into the live users/<id>/gpt locations.
    const target = join(restoredTeamRoot, "restored-gpt-profiles");
    try {
      await lstat(target);
      throw Error("PROFILE_RESTORE_EXISTS");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    await directory(staging, true);
    for (const profile of manifest.profiles) {
      for (const entry of profile.files) {
        await guard.check();
        const actual = await copyAndDigest(
          join(snapshot, profile.userId),
          entry.path,
          join(staging, profile.userId, entry.path),
        );
        if (actual.bytes !== entry.bytes || actual.sha256 !== entry.sha256)
          throw Error("PROFILE_BACKUP_CHECKSUM");
      }
    }
    await writeFile(join(staging, "profiles.json"), JSON.stringify(manifest, null, 2), {
      flag: "wx",
      mode: 0o600,
    });
    await verifyProfileSnapshot(staging);
    if (
      db.prepare("SELECT value FROM team_meta WHERE key='nativeAdmission'").get()?.value !==
        "blocked" ||
      profileIdentity(
        db,
        manifest.profiles.some((p) => p.legacy),
      ).identity !== manifest.identity
    )
      throw Error("PROFILE_OWNER_MAPPING_CHANGED");
    await guard.check();
    await rename(staging, target);
    return { path: target, nativeAdmission: "blocked", profiles: manifest.profiles.length };
  } finally {
    await rm(staging, { recursive: true, force: true });
    db?.close();
    await guard.close();
  }
}
