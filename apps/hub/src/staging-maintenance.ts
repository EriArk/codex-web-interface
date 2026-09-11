import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { inspectMachineStaging } from "@codex-web/machines";
import { type HubConfig, HubError, type StagingFile } from "@codex-web/shared";
import { storageBlocked } from "./storage.js";

export async function maintainMachineStaging(
  config: HubConfig,
  machineId: string,
  destination: string,
  probe = inspectMachineStaging,
) {
  const machine = config.machines.find((m) => m.id === machineId && m.type === "ssh-windows");
  if (!machine) throw new HubError(404, "MACHINE_NOT_FOUND", "Компьютер не найден.");
  const db = new DatabaseSync(config.hub.databasePath, { readOnly: true });
  let snapshot: string | undefined;
  const idle = () => {
    if (storageBlocked(db))
      throw new HubError(
        409,
        "STORAGE_BUSY",
        "Очистка дождётся завершения работы и проверки неопределённых отправок.",
      );
  };
  const hash = (data: Buffer) => createHash("sha256").update(data).digest("hex");
  const write = async (path: string, data: string | Buffer) => {
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
  };
  try {
    idle();
    const plan = await probe(machine, { op: "plan" }),
      files = plan.candidates ?? [];
    if (plan.partial)
      throw new HubError(
        409,
        "STORAGE_NEEDS_REVIEW",
        "Учёт копий неполный. Сначала проверь пути на компьютере.",
      );
    if (!files.length) return { snapshot: null, removedFiles: 0, reclaimedBytes: 0 };
    if (files.length > 100 || files.reduce((n, f) => n + f.bytes, 0) > 25 * 1024 * 1024)
      throw Error("STAGING_PLAN_LIMIT");
    const root = resolve(destination);
    if (!isAbsolute(destination) || root === dirname(root)) throw Error("STAGING_BACKUP_PATH");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const info = await lstat(root);
    if (
      info.isSymbolicLink() ||
      !info.isDirectory() ||
      (await realpath(root)) !== root ||
      (process.platform !== "win32" && info.mode & 0o077)
    )
      throw Error("STAGING_BACKUP_PRIVATE");
    snapshot = join(root, "staging-" + randomUUID());
    await mkdir(snapshot, { mode: 0o700 });
    const reply = await probe(machine, { op: "read", files }),
      contents = reply.contents ?? [];
    if (contents.length !== files.length) throw Error("STAGING_BACKUP_INCOMPLETE");
    const manifest: { file: StagingFile; backup: string }[] = [];
    for (let i = 0; i < files.length; i++) {
      const entry = contents[i],
        file = files[i]!;
      if (!entry || JSON.stringify(entry.file) !== JSON.stringify(file))
        throw Error("STAGING_BACKUP_IDENTITY");
      const data = Buffer.from(entry.base64, "base64");
      if (data.length !== file.bytes || hash(data) !== file.sha256)
        throw Error("STAGING_BACKUP_HASH");
      const name = `part-${i}.bin`;
      await write(join(snapshot, name), data);
      if (hash(await readFile(join(snapshot, name))) !== file.sha256)
        throw Error("STAGING_BACKUP_VERIFY");
      manifest.push({ file, backup: name });
    }
    await write(
      join(snapshot, "manifest.json"),
      JSON.stringify({
        format: 1,
        kind: "codex-web-staging-backup",
        machineId,
        createdAt: Date.now(),
        files: manifest,
      }),
    );
    // Make both the manifest entries and the snapshot directory durable before unlinking.
    for (const directory of [snapshot, root]) {
      const handle = await open(directory, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    idle();
    const result = await probe(machine, { op: "remove", files });
    return {
      snapshot,
      removedFiles: result.removed ?? 0,
      reclaimedBytes: result.reclaimedBytes ?? 0,
    };
  } catch (e) {
    if (e instanceof HubError) throw e;
    throw new HubError(
      409,
      "STAGING_MAINTENANCE_FAILED",
      snapshot
        ? `Очистка не подтверждена. Копия сохранена: ${snapshot}`
        : "Очистка не выполнена. Исходные копии сохранены.",
    );
  } finally {
    db.close();
  }
}
