import { constants } from "node:fs";
import { lstat, open, readdir, realpath, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { HubConfig, StorageReport } from "@codex-web/shared";
import { HubError } from "@codex-web/shared";
import { createSnapshot, verifySnapshot } from "./maintenance.js";

type FileEntry = { path: string; bytes: number; mtime: number; ino: number };
const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const disposable = new RegExp(
  "^(?:" +
    uuid +
    "\\.png|uploads/" +
    uuid +
    "\\.(?:bin|jpg)|gpt/" +
    uuid +
    "|previews/[0-9a-f]{64}\\.html)$",
);
const terminal = "('idle','completed','interrupted','failed')";
function blocked(db: DatabaseSync) {
  return (
    !!db.prepare("SELECT 1 FROM threads WHERE status NOT IN " + terminal + " LIMIT 1").get() ||
    !!db
      .prepare(
        "SELECT 1 FROM gpt_jobs WHERE status IN ('queued','preparing','running','unknown') LIMIT 1",
      )
      .get() ||
    !!db.prepare("SELECT 1 FROM commands WHERE state IN ('pending','unknown') LIMIT 1").get()
  );
}
function transient(db: DatabaseSync, cutoff: string, limit: number): number[] {
  // A complete native item must still match the durable message projection.
  // Reconnect after any removed delta receives the retained full completion event.
  return db
    .prepare(
      "SELECT e.seq FROM events e JOIN threads t ON t.id=e.threadId WHERE e.type='assistant.delta' AND e.createdAt<? AND t.status IN " +
        terminal +
        " AND (t.activeTurnId IS NULL OR t.activeTurnId<>e.turnId) AND EXISTS (SELECT 1 FROM events c JOIN messages m ON m.threadId=c.threadId AND m.id=json_extract(c.payload,'$.id') WHERE c.threadId=e.threadId AND c.turnId=e.turnId AND c.type='assistant.completed' AND c.seq>e.seq AND json_extract(c.payload,'$.id')=json_extract(e.payload,'$.id') AND m.text=json_extract(c.payload,'$.text')) AND EXISTS (SELECT 1 FROM events f WHERE f.threadId=e.threadId AND f.turnId=e.turnId AND f.type='turn.completed' AND json_extract(f.payload,'$.status') IN ('completed','interrupted','failed')) ORDER BY e.seq LIMIT ?",
    )
    .all(cutoff, limit)
    .map((r) => Number(r.seq));
}
async function safeRoot(root: string) {
  const target = resolve(root),
    info = await lstat(target);
  if (
    !isAbsolute(root) ||
    target === dirname(target) ||
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (await realpath(target)) !== target
  )
    throw new HubError(409, "STORAGE_PATH_UNSAFE", "Хранилище требует проверки пути.");
  return target;
}
async function inventory(root: string) {
  const files: FileEntry[] = [],
    budget = { left: 100000 };
  let partial = false;
  const walk = async (prefix: string, depth: number) => {
    const directory = join(root, prefix);
    const info = await lstat(directory);
    if (info.isSymbolicLink() || (await realpath(directory)) !== resolve(directory)) {
      partial = true;
      return;
    }
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (--budget.left < 0) {
        partial = true;
        return;
      }
      const path = prefix ? prefix + "/" + entry.name : entry.name,
        full = join(root, path);
      const info = await lstat(full);
      if (entry.isSymbolicLink() || info.isSymbolicLink()) {
        partial = true;
        continue;
      }
      if (entry.isFile() && info.isFile())
        files.push({ path, bytes: info.size, mtime: info.mtimeMs, ino: info.ino });
      else if (
        entry.isDirectory() &&
        depth < 4 &&
        (["uploads", "gpt", "previews"].includes(path) || path.startsWith("uploads/staged"))
      )
        await walk(path, depth + 1);
      else partial = true;
    }
  };
  await walk("", 0);
  return { files, partial };
}
function references(db: DatabaseSync) {
  const required = new Set<string>(),
    optional = new Set<string>();
  for (const row of db.prepare("SELECT id FROM artifacts").all()) required.add(row.id + ".png");
  for (const row of db.prepare("SELECT id,image FROM attachments").all()) {
    required.add("uploads/" + row.id + ".bin");
    if (row.image) required.add("uploads/" + row.id + ".jpg");
  }
  for (const row of db.prepare("SELECT id FROM gpt_uploads").all()) required.add("gpt/" + row.id);
  for (const row of db.prepare("SELECT id FROM html_previews").all())
    optional.add("previews/" + row.id + ".html");
  for (const row of db.prepare("SELECT files FROM gpt_jobs").all()) {
    const files = JSON.parse(String(row.files));
    if (!Array.isArray(files))
      throw new HubError(409, "STORAGE_NEEDS_REVIEW", "Нужно проверить записи вложений GPT.");
    for (const file of files) {
      const id = typeof file === "string" ? file : file?.id;
      if (typeof id === "string" && new RegExp("^" + uuid + "$").test(id))
        required.add("gpt/" + id);
    }
  }
  return { required, optional };
}
async function plan(config: HubConfig, db: DatabaseSync, now: number) {
  const root = await safeRoot(config.hub.resultsPath),
    data = await inventory(root),
    refs = references(db),
    present = new Set(data.files.map((f) => f.path));
  const orphans = data.files
    .filter(
      (file) =>
        disposable.test(file.path) &&
        !refs.required.has(file.path) &&
        !refs.optional.has(file.path) &&
        file.mtime < now - config.hub.storage.orphanDays * 86400000,
    )
    .sort((a, b) => a.path.localeCompare(b.path))
    .slice(0, config.hub.storage.batchSize);
  const deltas = transient(
    db,
    new Date(now - config.hub.storage.transientDays * 86400000).toISOString(),
    config.hub.storage.batchSize,
  );
  return {
    ...data,
    root,
    orphans,
    deltas,
    missing: [...refs.required].filter((path) => !present.has(path)).length,
  };
}
export async function storageReport(
  config: HubConfig,
  db: DatabaseSync,
  now = Date.now(),
): Promise<StorageReport> {
  const data = await plan(config, db, now),
    policy = config.hub.storage;
  let databaseBytes = 0;
  for (const suffix of ["", "-wal", "-shm"])
    try {
      databaseBytes += (await lstat(config.hub.databasePath + suffix)).size;
    } catch {}
  const sum = (match: (path: string) => boolean) =>
    data.files.filter((f) => match(f.path)).reduce((n, f) => n + f.bytes, 0);
  const windows = new Set(
    config.machines
      .filter((machine) => machine.type === "ssh-windows")
      .map((machine) => machine.id),
  );
  const windowsProjects = new Set(
    config.projects
      .filter((project) => windows.has(project.machineId))
      .map((project) => project.id),
  );
  for (const row of db.prepare("SELECT id,machineId FROM catalog_projects").all())
    if (windows.has(String(row.machineId))) windowsProjects.add(String(row.id));
  let stagedEstimate = 0;
  for (const row of db
    .prepare(
      "SELECT t.projectId,sum(a.bytes) AS bytes FROM attachments a JOIN threads t ON t.id=a.threadId WHERE a.messageId IS NOT NULL GROUP BY t.projectId",
    )
    .all())
    if (windowsProjects.has(String(row.projectId))) stagedEstimate += Number(row.bytes);
  const values: [string, number, number | undefined, boolean?][] = [
    ["database", databaseBytes, policy.databaseWarningBytes],
    [
      "artifacts",
      sum((path) => new RegExp("^" + uuid + "\\.png$").test(path)),
      policy.artifactBytes,
    ],
    [
      "uploads",
      sum((path) => path.startsWith("uploads/") && !path.startsWith("uploads/staged/")),
      policy.attachmentBytes,
    ],
    ["gpt", sum((path) => path.startsWith("gpt/")), policy.gptUploadBytes],
    ["previews", sum((path) => path.startsWith("previews/")), 2000 * 2 * 1024 ** 2],
    ["local-staging", sum((path) => path.startsWith("uploads/staged/")), undefined],
    ["windows-staging", stagedEstimate, undefined, true],
  ];
  return {
    buckets: values.map(([id, bytes, limit, estimated]) => ({
      id,
      bytes,
      limit,
      estimated,
      warning: !!limit && bytes >= limit * 0.8,
    })),
    partial: data.partial,
    missingFiles: data.missing,
    orphanFiles: data.orphans.length,
    reclaimableBytes: data.orphans.reduce((n, f) => n + f.bytes, 0),
    transientEvents: data.deltas.length,
    blocked: blocked(db),
    policy,
  };
}
export async function compactStorage(
  config: HubConfig,
  options: { backupDirectory: string; now?: number; revision?: string },
) {
  const db = new DatabaseSync(config.hub.databasePath),
    now = options.now ?? Date.now();
  db.exec("PRAGMA busy_timeout=5000");
  try {
    if (blocked(db))
      throw new HubError(
        409,
        "STORAGE_BUSY",
        "Очистка дождётся завершения работы и проверки неопределённых отправок.",
      );
    const data = await plan(config, db, now);
    if (data.partial || data.missing)
      throw new HubError(409, "STORAGE_NEEDS_REVIEW", "Сначала проверь целостность хранилища.");
    if (!data.deltas.length && !data.orphans.length)
      return { snapshot: null, removedEvents: 0, removedFiles: 0, reclaimedBytes: 0 };
    const snapshot = await createSnapshot(config, options.backupDirectory, {
      revision: options.revision,
      extraResultFiles: data.orphans.map((f) => f.path),
    });
    await verifySnapshot(snapshot);
    let removedEvents = 0,
      removedFiles = 0,
      bytes = 0;
    db.exec("BEGIN IMMEDIATE");
    try {
      if (blocked(db))
        throw new HubError(
          409,
          "STORAGE_BUSY",
          "Во время подготовки началась работа. Очистка отложена.",
        );
      const current = transient(
        db,
        new Date(now - config.hub.storage.transientDays * 86400000).toISOString(),
        config.hub.storage.batchSize,
      );
      const selected = new Set(data.deltas);
      for (const seq of current)
        if (selected.has(seq))
          removedEvents += Number(
            db.prepare("DELETE FROM events WHERE seq=? AND type='assistant.delta'").run(seq)
              .changes,
          );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    for (const file of data.orphans) {
      const id = file.path.split("/").at(-1)?.split(".")[0] ?? "";
      const table = file.path.startsWith("uploads/")
        ? "attachments"
        : file.path.startsWith("gpt/")
          ? "gpt_uploads"
          : file.path.startsWith("previews/")
            ? "html_previews"
            : "artifacts";
      if (db.prepare("SELECT 1 FROM " + table + " WHERE id=?").get(id)) continue;
      const path = join(data.root, file.path),
        parent = dirname(path),
        rel = relative(data.root, path);
      if (
        !disposable.test(rel.replaceAll("\\\\", "/")) ||
        isAbsolute(rel) ||
        rel.startsWith("..") ||
        (await realpath(parent)) !== resolve(parent)
      )
        continue;
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const current = await handle.stat(),
          listed = await lstat(path);
        if (
          !current.isFile() ||
          listed.isSymbolicLink() ||
          current.ino !== file.ino ||
          current.size !== file.bytes ||
          current.mtimeMs !== file.mtime ||
          listed.ino !== current.ino
        )
          continue;
        await unlink(path);
        removedFiles++;
        bytes += file.bytes;
      } finally {
        await handle.close();
      }
    }
    db.exec("PRAGMA wal_checkpoint(PASSIVE)");
    return { snapshot, removedEvents, removedFiles, reclaimedBytes: bytes };
  } finally {
    db.close();
  }
}
