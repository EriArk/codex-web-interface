import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { HubConfig } from "@codex-web/shared";
import { loadConfig } from "./config.js";
import { migrateDatabase, SCHEMA_VERSION, schemaVersion } from "./migrations.js";

class MaintenanceError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
const fail = (code: string, message: string): never => {
  throw new MaintenanceError(code, message);
};
const inside = (root: string, path: string) => {
  const rel = relative(resolve(root), resolve(path));
  return rel !== "" && !rel.startsWith(".." + sep) && rel !== ".." && !isAbsolute(rel);
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type Entry = { path: string; bytes: number; sha256: string };
interface Manifest {
  format: 1 | 2;
  cachedPreviews?: string[];
  kind: "codex-web-backup";
  createdAt: string;
  appVersion: string;
  revision: string;
  schemaVersion: number;
  files: Entry[];
}
async function privateDirectory(path: string, create = true) {
  if (!isAbsolute(path) || resolve(path) === sep)
    fail("UNSAFE_DIRECTORY", "Use an absolute private directory");
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (await realpath(path)) !== resolve(path) ||
    (process.platform !== "win32" && (info.mode & 0o077) !== 0)
  )
    fail("UNSAFE_DIRECTORY", "Directory must be private (0700) and must not use symlinks");
}
async function bytesAt(root: string, path: string): Promise<Buffer> {
  const target = join(root, path);
  if (!inside(root, target) || (await realpath(target)) !== resolve(target))
    fail("UNSAFE_FILE", "Snapshot paths must remain inside their private root without symlinks");
  const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 64 * 1024 ** 2)
      fail("UNSAFE_FILE", "Expected a regular file up to 64 MiB");
    return await file.readFile();
  } finally {
    await file.close();
  }
}
async function fileAt(root: string, path: string) {
  const target = join(root, path);
  if (!inside(root, target) || (await realpath(target)) !== resolve(target))
    fail("UNSAFE_FILE", "File must remain inside its private root without symlinks");
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  if (!(await handle.stat()).isFile()) {
    await handle.close();
    fail("UNSAFE_FILE", "Expected a regular file");
  }
  return handle;
}
async function digestAt(root: string, path: string): Promise<Entry> {
  const file = await fileAt(root, path),
    hash = createHash("sha256");
  let bytes = 0;
  try {
    const buffer = Buffer.alloc(65536);
    for (;;) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      bytes += bytesRead;
      hash.update(buffer.subarray(0, bytesRead));
    }
    return { path, bytes, sha256: hash.digest("hex") };
  } finally {
    await file.close();
  }
}
async function copyAt(root: string, path: string, target: string) {
  const source = await fileAt(root, path);
  try {
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const destination = await open(target, "wx", 0o600);
    try {
      const buffer = Buffer.alloc(65536);
      for (;;) {
        const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        let offset = 0;
        while (offset < bytesRead) {
          const { bytesWritten } = await destination.write(
            buffer,
            offset,
            bytesRead - offset,
            null,
          );
          if (!bytesWritten) fail("COPY_FAILED", "Could not write snapshot file");
          offset += bytesWritten;
        }
      }
    } finally {
      await destination.close();
    }
  } finally {
    await source.close();
  }
}
async function tree(root: string, prefix = ""): Promise<string[]> {
  const result: string[] = [];
  for (const item of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? prefix + "/" + item.name : item.name;
    if (path.split("/").length > 20 || item.isSymbolicLink())
      fail("UNSAFE_FILE", "Symlinks or excessive nesting are not supported");
    if (item.isDirectory()) result.push(...(await tree(root, path)));
    else if (item.isFile()) result.push(path);
    else fail("UNSAFE_FILE", "Only regular files are supported");
  }
  return result;
}
function requiredResults(db: DatabaseSync): string[] {
  const paths: string[] = [];
  for (const row of db
    .prepare(
      db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='artifact_files'").get()
        ? "SELECT a.id, CASE WHEN f.id IS NULL THEN '.png' ELSE '.bin' END AS extension FROM artifacts a LEFT JOIN artifact_files f ON f.id=a.id"
        : "SELECT id, '.png' AS extension FROM artifacts",
    )
    .all()) {
    if (!uuid.test(String(row.id))) fail("INVALID_FILE_ID", "Invalid stored artifact identifier");
    paths.push(String(row.id) + String(row.extension));
  }
  for (const row of db.prepare("SELECT id,image FROM attachments").all()) {
    if (!uuid.test(String(row.id))) fail("INVALID_FILE_ID", "Invalid stored attachment identifier");
    paths.push("uploads/" + String(row.id) + ".bin");
    if (row.image) paths.push("uploads/" + String(row.id) + ".jpg");
  }
  if (hasTable(db, "gpt_uploads"))
    for (const row of db.prepare("SELECT id FROM gpt_uploads").all()) {
      if (!uuid.test(String(row.id)))
        fail("INVALID_FILE_ID", "Invalid stored GPT upload identifier");
      paths.push("gpt/" + String(row.id));
    }
  if (hasTable(db, "gpt_jobs"))
    for (const row of db.prepare("SELECT files FROM gpt_jobs").all()) {
      const files = JSON.parse(String(row.files));
      if (!Array.isArray(files)) fail("INVALID_FILE_ID", "Invalid GPT job files");
      for (const file of files) {
        const id = typeof file === "string" ? file : file?.id;
        if (!uuid.test(String(id))) fail("INVALID_FILE_ID", "Invalid GPT job file identifier");
        paths.push("gpt/" + id);
      }
    }
  return [...new Set(paths)];
}
function hasTable(db: DatabaseSync, table: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
}
function previewIds(db: DatabaseSync): string[] {
  if (!hasTable(db, "html_previews")) return [];
  return db
    .prepare("SELECT id FROM html_previews")
    .all()
    .map((row) => {
      const id = String(row.id);
      if (!/^[a-f0-9]{64}$/.test(id)) fail("INVALID_FILE_ID", "Invalid stored preview identifier");
      return id;
    });
}
function inspectDatabase(db: DatabaseSync): number {
  const version = schemaVersion(db);
  if (version < 1 || version > SCHEMA_VERSION)
    fail("DB_SCHEMA_UNSUPPORTED", "Snapshot schema is not supported by this application");
  if (
    db.prepare("PRAGMA quick_check").get()?.quick_check !== "ok" ||
    db.prepare("PRAGMA foreign_key_check").all().length
  )
    fail("DB_INTEGRITY_FAILED", "Snapshot database integrity check failed");
  return version;
}
export async function verifySnapshot(directory: string): Promise<Manifest> {
  await privateDirectory(directory, false);
  const raw = JSON.parse((await bytesAt(directory, "manifest.json")).toString()) as Manifest;
  if (
    ![1, 2].includes(raw.format) ||
    (raw.format === 2 &&
      (!Array.isArray(raw.cachedPreviews) || raw.cachedPreviews.length > 2000)) ||
    raw.kind !== "codex-web-backup" ||
    !Array.isArray(raw.files) ||
    raw.files.length > 100000 ||
    !Number.isInteger(raw.schemaVersion)
  )
    fail("INVALID_SNAPSHOT", "Unrecognized backup manifest");
  const files = new Set<string>();
  for (const file of raw.files) {
    if (
      typeof file.path !== "string" ||
      !/^(app\.db|results\/.+|private\/.+)$/.test(file.path) ||
      file.path.split("/").some((p) => !p || p === "." || p === "..") ||
      file.path.includes("\\") ||
      files.has(file.path)
    )
      fail("INVALID_SNAPSHOT", "Invalid or duplicate snapshot file");
    files.add(file.path);
    const digest = await digestAt(directory, file.path);
    if (digest.bytes !== file.bytes || digest.sha256 !== file.sha256)
      fail("SNAPSHOT_MISMATCH", "Snapshot file size or checksum does not match");
  }
  if (!files.has("app.db")) fail("INVALID_SNAPSHOT", "Snapshot has no database");
  const actual = (await tree(directory)).filter((path) => path !== "manifest.json");
  if (actual.length !== files.size || actual.some((path) => !files.has(path)))
    fail("INVALID_SNAPSHOT", "Snapshot contains unlisted files");
  const db = new DatabaseSync(join(directory, "app.db"), { readOnly: true });
  try {
    if (inspectDatabase(db) !== raw.schemaVersion)
      fail("INVALID_SNAPSHOT", "Schema metadata mismatch");
    for (const path of requiredResults(db))
      if (!files.has("results/" + path))
        fail("SNAPSHOT_INCOMPLETE", "A referenced artifact or upload is missing");
    if (raw.format === 2) {
      const known = new Set(previewIds(db)),
        cached = new Set<string>();
      for (const id of raw.cachedPreviews ?? []) {
        if (typeof id !== "string" || !known.has(id) || cached.has(id))
          fail("INVALID_SNAPSHOT", "Invalid cached preview inventory");
        cached.add(id);
        if (!files.has("results/previews/" + id + ".html"))
          fail("SNAPSHOT_INCOMPLETE", "A captured HTML preview is missing");
      }
    }
  } finally {
    db.close();
  }
  return raw;
}
export async function createSnapshot(
  config: HubConfig,
  destination: string,
  options: {
    keep?: number;
    revision?: string;
    privateFiles?: { name: string; path: string }[];
    extraResultFiles?: string[];
  } = {},
): Promise<string> {
  const keep = options.keep ?? 7;
  if (!Number.isInteger(keep) || keep < 1 || keep > 100)
    fail("INVALID_RETENTION", "Keep count must be between 1 and 100");
  await privateDirectory(destination);
  if (
    inside(config.hub.resultsPath, destination) ||
    resolve(destination) === resolve(config.hub.resultsPath)
  )
    fail("UNSAFE_DIRECTORY", "Backups must be outside the Results directory");
  const name =
    "codex-backup-" + new Date().toISOString().replace(/[:.]/g, "-") + "-" + randomUUID();
  const staging = join(destination, ".partial-" + randomUUID()),
    completed = join(destination, name);
  await privateDirectory(staging);
  try {
    const source = new DatabaseSync(config.hub.databasePath, { readOnly: true });
    try {
      inspectDatabase(source);
      await backup(source, join(staging, "app.db"));
    } finally {
      source.close();
    }
    await chmod(join(staging, "app.db"), 0o600);
    const db = new DatabaseSync(join(staging, "app.db"));
    let paths: string[], previews: string[], version: number;
    const cachedPreviews: string[] = [];
    try {
      db.exec("PRAGMA journal_mode=DELETE");
      version = inspectDatabase(db);
      paths = [...requiredResults(db), ...(options.extraResultFiles ?? [])];
      previews = previewIds(db);
    } finally {
      db.close();
    }
    // Unopened previews have only a source reference; preserve captured documents
    // without reading project files or contacting an execution machine during backup.
    for (const id of previews) {
      const path = "previews/" + id + ".html";
      try {
        const info = await lstat(join(config.hub.resultsPath, path));
        if (!info.isFile() || info.isSymbolicLink())
          fail("UNSAFE_FILE", "Preview cache must contain regular files");
        paths.push(path);
        cachedPreviews.push(id);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    // Local-Linux staged attachment copies may be referenced by native history.
    const staged = join(config.hub.resultsPath, "uploads", "staged");
    try {
      const info = await lstat(staged);
      if (!info.isDirectory() || info.isSymbolicLink())
        fail("UNSAFE_FILE", "Staged uploads must be a regular private directory");
      paths.push(...(await tree(staged)).map((path) => "uploads/staged/" + path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    for (const path of new Set(paths)) {
      await copyAt(config.hub.resultsPath, path, join(staging, "results", path));
    }
    try {
      await copyAt(
        dirname(config.hub.databasePath),
        "push-keys.json",
        join(staging, "private", "push-keys.json"),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    for (const file of options.privateFiles ?? []) {
      if (
        !/^(config\.(json|yaml|yml)|remote\.env|deploy\.env|ssh\/[\w.-]+|tunnel\/[\w.-]+)$/.test(
          file.name,
        ) ||
        /(^|\/)auth\.json$/.test(file.name) ||
        !isAbsolute(file.path) ||
        ["auth.json", "cert.pem"].includes(basename(file.path).toLowerCase()) ||
        file.name.split("/").some((part) => part === "." || part === "..")
      )
        fail(
          "INVALID_PRIVATE_FILE",
          "Only explicit deployment configuration and SSH/ingress files can be packaged",
        );
      await copyAt(
        dirname(file.path),
        file.path.split(/[\\/]/).at(-1) ?? "",
        join(staging, "private", file.name),
      );
    }
    const files: Entry[] = [];
    for (const path of await tree(staging)) {
      files.push(await digestAt(staging, path));
    }
    const manifest: Manifest = {
      format: 2,
      cachedPreviews,
      kind: "codex-web-backup",
      createdAt: new Date().toISOString(),
      appVersion: "0.1.0",
      revision: /^[0-9a-f]{7,40}$/.test(options.revision ?? "") ? options.revision! : "unknown",
      schemaVersion: version,
      files,
    };
    await writeFile(join(staging, "manifest.json"), JSON.stringify(manifest, null, 2), {
      mode: 0o600,
      flag: "wx",
    });
    await verifySnapshot(staging);
    await rename(staging, completed);
    // Only fully verified snapshots created by this tool participate in retention.
    const candidates: string[] = [];
    for (const item of await readdir(destination, { withFileTypes: true })) {
      if (!item.isDirectory() || !/^codex-backup-[0-9TZ-]+-[0-9a-f-]{36}$/.test(item.name))
        continue;
      const path = join(destination, item.name);
      try {
        await verifySnapshot(path);
        candidates.push(path);
      } catch {
        /* Never delete an unrecognized or damaged directory. */
      }
    }
    candidates.sort().reverse();
    for (const path of candidates.slice(keep)) {
      if (!inside(destination, path) || (await realpath(path)) !== path)
        fail("UNSAFE_DIRECTORY", "Unsafe retention target");
      await rm(path, { recursive: true });
    }
    return completed;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
export async function restoreSnapshot(snapshot: string, target: string): Promise<void> {
  const manifest = await verifySnapshot(snapshot);
  if (!isAbsolute(target) || inside(snapshot, target) || resolve(snapshot) === resolve(target))
    fail("UNSAFE_DIRECTORY", "Restore into a new private location outside the snapshot");
  await privateDirectory(dirname(target));
  try {
    await lstat(target);
    fail(
      "RESTORE_TARGET_EXISTS",
      "Restore destination must not exist; never overwrite a live installation",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const staging = join(dirname(target), ".restore-" + randomUUID());
  await privateDirectory(staging);
  try {
    for (const entry of manifest.files) {
      await copyAt(snapshot, entry.path, join(staging, entry.path));
      const digest = await digestAt(staging, entry.path);
      if (digest.sha256 !== entry.sha256 || digest.bytes !== entry.bytes)
        fail("SNAPSHOT_MISMATCH", "Snapshot changed during restore");
    }
    if (manifest.files.some((entry) => entry.path === "private/push-keys.json"))
      await copyAt(staging, "private/push-keys.json", join(staging, "push-keys.json"));
    await mkdir(join(staging, "results"), { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(join(staging, "app.db"));
    try {
      migrateDatabase(db, join(staging, "app.db"));
      db.exec(
        "BEGIN IMMEDIATE; DELETE FROM sessions; DELETE FROM bootstrap; UPDATE commands SET state='unknown' WHERE state='pending'; UPDATE threads SET status='unknown' WHERE status IN ('starting','running','waiting_approval'); COMMIT;",
      );
      db.exec("UPDATE usage_reset_operations SET state='unknown' WHERE state='pending'");
      // A queued job in an older backup may have already reached ChatGPT since
      // that snapshot. Restoration must not replay it, even if submitted was false.
      db.prepare(
        "UPDATE gpt_jobs SET status='unknown',error=? WHERE status IN ('queued','preparing','running')",
      ).run("Восстановлено из резервной копии. Проверь ответ в ChatGPT перед повторной отправкой.");
      db.prepare(
        "UPDATE project_work_actions SET state='unknown',value=json_set(value,'$.state','unknown','$.error',?) WHERE state IN ('dispatching','queued','running')",
      ).run(
        "Восстановлено из резервной копии. Проверь выполнение в исходном чате; повторной отправки не будет.",
      );
      db.exec(
        "UPDATE auth_state SET revision=revision+1,recoveryHash=NULL,recoveryExpires=NULL WHERE id=1",
      );
      inspectDatabase(db);
    } finally {
      db.close();
    }
    await writeFile(
      join(staging, "restore.json"),
      JSON.stringify({
        restoredAt: new Date().toISOString(),
        sessionsRevoked: true,
        sourceCreatedAt: manifest.createdAt,
      }),
      { mode: 0o600 },
    );
    await rename(staging, target);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
export async function createRecoveryLink(config: HubConfig, output: string) {
  if (!isAbsolute(output)) fail("UNSAFE_FILE", "Use an absolute private recovery file path");
  await privateDirectory(dirname(output));
  if (!(await lstat(config.hub.databasePath)).isFile())
    fail("UNSAFE_FILE", "Expected an existing Hub database");
  const db = new DatabaseSync(config.hub.databasePath);
  let written = false;
  try {
    if (inspectDatabase(db) !== SCHEMA_VERSION)
      fail("DB_SCHEMA_UNSUPPORTED", "Run the matching updated Hub before creating a recovery link");
    if (!db.prepare("SELECT 1 FROM users WHERE username=?").get(config.auth.username))
      fail("OWNER_NOT_CONFIGURED", "Use first enrollment for an unconfigured installation");
    const revision = db.prepare("SELECT revision FROM auth_state WHERE id=1").get()?.revision;
    const token = randomBytes(32).toString("base64url"),
      expires = Date.now() + 15 * 60000;
    const url = new URL(config.hub.publicBaseUrl);
    url.hash = new URLSearchParams({ recover: token }).toString();
    await writeFile(output, url.href + "\n", { mode: 0o600, flag: "wx" });
    written = true;
    const updated = db
      .prepare("UPDATE auth_state SET recoveryHash=?,recoveryExpires=? WHERE id=1 AND revision=?")
      .run(createHash("sha256").update(token).digest("hex"), expires, revision ?? -1);
    if (!updated.changes)
      fail("CREDENTIALS_CHANGED", "Access changed during recovery-link creation; try again");
    return { path: output, expiresAt: new Date(expires).toISOString() };
  } catch (error) {
    if (written) await rm(output, { force: true });
    throw error;
  } finally {
    db.close();
  }
}
async function cli() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: "string" },
      destination: { type: "string" },
      snapshot: { type: "string" },
      target: { type: "string" },
      output: { type: "string" },
      keep: { type: "string" },
      revision: { type: "string" },
      "private-file": { type: "string", multiple: true },
    },
  });
  const operation = positionals[0];
  if (operation === "backup" && values.config && values.destination) {
    const privateFiles = (values["private-file"] ?? []).map((value) => {
      const index = value.indexOf("=");
      if (index < 1) fail("INVALID_PRIVATE_FILE", "Use name=absolute-path for deployment files");
      return { name: value.slice(0, index), path: value.slice(index + 1) };
    });
    const path = await createSnapshot(loadConfig(values.config), values.destination, {
      keep: Number(values.keep ?? 7),
      revision: values.revision ?? process.env.HUB_REVISION,
      privateFiles,
    });
    console.log(JSON.stringify({ ok: true, snapshot: path }));
  } else if (operation === "verify" && values.snapshot) {
    const manifest = await verifySnapshot(values.snapshot);
    console.log(
      JSON.stringify({
        ok: true,
        schemaVersion: manifest.schemaVersion,
        files: manifest.files.length,
        revision: manifest.revision,
      }),
    );
  } else if (operation === "restore" && values.snapshot && values.target) {
    await restoreSnapshot(values.snapshot, values.target);
    console.log(JSON.stringify({ ok: true, sessionsRevoked: true }));
  } else if (operation === "recovery" && values.config && values.output) {
    const link = await createRecoveryLink(loadConfig(values.config), values.output);
    console.log(JSON.stringify({ ok: true, ...link }));
  } else
    fail(
      "USAGE",
      "Use backup --config PATH --destination PRIVATE_DIR; verify --snapshot DIR; restore --snapshot DIR --target NEW_PRIVATE_DIR; recovery --config PATH --output PRIVATE_FILE",
    );
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  void cli().catch((error) => {
    const code =
      error instanceof MaintenanceError || error?.name === "SchemaError"
        ? error.code
        : "MAINTENANCE_FAILED";
    console.error(
      JSON.stringify({
        ok: false,
        code,
        message:
          error instanceof MaintenanceError
            ? error.message
            : "Operation failed; the previous state was not overwritten",
      }),
    );
    process.exitCode = 1;
  });
}
