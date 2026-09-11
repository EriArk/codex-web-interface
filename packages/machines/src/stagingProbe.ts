import type { Dirent, Stats } from "node:fs";
import type { StagingFile, StagingRequest, StagingResponse } from "@codex-web/shared";

// Self-contained fixed filesystem operation, serialized for the existing SSH transport.
export async function stagingProbe(
  root: string,
  request: StagingRequest,
): Promise<StagingResponse> {
  const fs = await import("node:fs/promises"),
    path = await import("node:path"),
    crypto = await import("node:crypto"),
    constants = (await import("node:fs")).constants;
  const now = Date.now(),
    uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
    partialName = new RegExp(
      "^attachments/[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}/" + uuid + "/\\.upload-" + uuid + "\\.part$",
    );
  const output: StagingResponse = {
    bytes: 0,
    files: 0,
    temporaryBytes: 0,
    temporaryFiles: 0,
    previewBytes: 0,
    receipts: 0,
    partial: false,
    checkedAt: now,
  };
  const fail = (): never => {
    throw Error("STAGING_UNSAFE");
  };
  const base = path.resolve(root);
  const safe = async (target: string) => {
    const full = path.resolve(target),
      rel = path.relative(base, full);
    if (
      rel === ".." ||
      rel.startsWith(".." + path.sep) ||
      path.isAbsolute(rel) ||
      full === path.dirname(full)
    )
      fail();
    let cursor = full;
    while (true) {
      const info = await fs.lstat(cursor);
      if (info.isSymbolicLink()) fail();
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
    return full;
  };
  try {
    await safe(base);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return output;
    throw e;
  }
  const candidates: StagingFile[] = [];
  let remaining = 50000,
    selectedBytes = 0;
  const scan = async (relative: string, depth: number) => {
    if (depth > 4) {
      output.partial = true;
      return;
    }
    const directory = path.join(base, relative);
    let entries: Dirent[];
    try {
      await safe(directory);
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") output.partial = true;
      return;
    }
    for (const entry of entries) {
      if (--remaining < 0) {
        output.partial = true;
        return;
      }
      const rel = relative + "/" + entry.name,
        file = path.join(base, rel);
      let info: Stats;
      try {
        info = await fs.lstat(file);
      } catch {
        output.partial = true;
        continue;
      }
      if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) {
        output.partial = true;
        continue;
      }
      if (info.isDirectory()) {
        await scan(rel, depth + 1);
        continue;
      }
      if (relative.startsWith("attachments")) {
        output.bytes += info.size;
        output.files++;
        if (partialName.test(rel)) {
          output.temporaryBytes += info.size;
          output.temporaryFiles++;
          if (
            request.op === "plan" &&
            info.mtimeMs < now - 30 * 86400000 &&
            candidates.length < 100 &&
            info.size <= 25 * 1024 * 1024 - selectedBytes &&
            info.nlink === 1
          ) {
            try {
              await safe(file);
              const bytes = await fs.readFile(file);
              if (bytes.length !== info.size) {
                output.partial = true;
                continue;
              }
              candidates.push({
                path: rel,
                bytes: info.size,
                mtime: info.mtimeMs,
                sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
              });
              selectedBytes += info.size;
            } catch {
              output.partial = true;
            }
          }
        }
      } else if (relative.startsWith("gui-preview/state")) {
        if (entry.name.endsWith(".png") || entry.name.endsWith(".png.tmp"))
          output.previewBytes += info.size;
        if (entry.name.endsWith(".request.json")) output.receipts++;
      }
    }
  };
  if (request.op === "inspect" || request.op === "plan") {
    await scan("attachments", 0);
    await scan("gui-preview/state", 0);
    if (request.op === "plan") output.candidates = candidates;
    return output;
  }
  if (
    (request.op !== "read" && request.op !== "remove") ||
    !Array.isArray(request.files) ||
    request.files.length > 100 ||
    request.files.reduce((n, f) => n + f.bytes, 0) > 25 * 1024 * 1024
  )
    fail();
  output.contents = [];
  output.removed = 0;
  output.reclaimedBytes = 0;
  for (const item of request.files) {
    if (
      !item ||
      !partialName.test(item.path) ||
      !Number.isSafeInteger(item.bytes) ||
      item.bytes < 0 ||
      !Number.isFinite(item.mtime) ||
      !/^[a-f0-9]{64}$/.test(item.sha256) ||
      item.mtime >= now - 30 * 86400000
    )
      fail();
    const full = await safe(path.join(base, item.path));
    const handle = await fs.open(
      full,
      constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
    );
    try {
      const before = await handle.stat();
      if (
        !before.isFile() ||
        before.nlink !== 1 ||
        before.size !== item.bytes ||
        before.mtimeMs !== item.mtime
      )
        fail();
      const bytes = await handle.readFile(),
        after = await fs.lstat(full);
      if (
        !before.isFile() ||
        after.isSymbolicLink() ||
        before.nlink !== 1 ||
        after.nlink !== 1 ||
        before.ino !== after.ino ||
        before.size !== item.bytes ||
        after.size !== item.bytes ||
        before.mtimeMs !== item.mtime ||
        after.mtimeMs !== item.mtime ||
        crypto.createHash("sha256").update(bytes).digest("hex") !== item.sha256
      )
        fail();
      if (request.op === "read")
        output.contents.push({ file: item, base64: bytes.toString("base64") });
      else {
        await safe(full);
        await fs.unlink(full);
        output.removed++;
        output.reclaimedBytes += item.bytes;
      }
    } finally {
      await handle.close();
    }
  }
  return output;
}
