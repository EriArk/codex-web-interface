import type { FileImport, FileRequest, FileSnapshot } from "@codex-web/shared";

// Self-contained: sent to the configured Node over the existing SSH connection.
export async function fileToolsProbe(
  root: string,
  request: Omit<FileRequest, "op"> & { op: FileRequest["op"] | "import" | "import-check" },
  receiptRoot?: string,
  upload?: FileImport,
): Promise<FileSnapshot> {
  const fs = await import("node:fs/promises"),
    paths = await import("node:path"),
    crypto = await import("node:crypto"),
    os = await import("node:os"),
    streams = await import("node:fs");
  const fail = (code: string): never => {
    throw Error(code);
  };
  const hash = (data: string | Buffer) => crypto.createHash("sha256").update(data).digest("hex");
  const deadline =
    Date.now() +
    (upload ? Math.max(60000, Math.min(1740000, (upload.bytes / 262144) * 1000)) : 60000);
  const bounded = () => {
    if (Date.now() > deadline) fail("FILE_TREE_LARGE");
  };
  const denied = (part: string) =>
    /^(?:\.git|\.ssh|\.codex|\.aws|\.azure|\.gnupg|\.npmrc|\.pypirc|auth\.json|credentials(?:\..*)?|id_(?:rsa|ed25519|ecdsa)(?:\..*)?|\.env(?:\..*)?|\.codexweb-file-.*)$/i.test(
      part,
    ) || /\.(?:pem|key|p12|pfx)$/i.test(part);
  if (!paths.isAbsolute(root)) fail("FILE_PATH");
  for (let p = paths.resolve(root); ; ) {
    if ((await fs.lstat(p)).isSymbolicLink()) fail("FILE_PATH");
    const parent = paths.dirname(p);
    if (p === parent) break;
    p = parent;
  }
  const base = await fs.realpath(root);
  const scoped = async (value: string, missing = false) => {
    if (
      !value ||
      value.length > 2048 ||
      /[\\:*?"<>|]/.test(value) ||
      Array.from(value).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
      paths.isAbsolute(value) ||
      value
        .split("/")
        .some(
          (p) =>
            !p ||
            p === "." ||
            p === ".." ||
            denied(p) ||
            /[. ]$/.test(p) ||
            /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(p),
        )
    )
      fail("FILE_PATH");
    const full = paths.resolve(base, value),
      rel = paths.relative(base, full);
    if (!rel || rel.startsWith(".." + paths.sep) || rel === ".." || paths.isAbsolute(rel))
      fail("FILE_PATH");
    for (let p = full; p !== base; p = paths.dirname(p)) {
      bounded();
      try {
        if ((await fs.lstat(p)).isSymbolicLink()) fail("FILE_PATH");
      } catch (e) {
        if (!(missing && p === full && (e as NodeJS.ErrnoException).code === "ENOENT")) throw e;
      }
    }
    return full;
  };
  const fingerprint = async (
    full: string,
  ): Promise<{ fingerprint: string; kind: "file" | "directory"; size: number }> => {
    let count = 0,
      size = 0;
    const digest = crypto.createHash("sha256");
    const visit = async (file: string) => {
      bounded();
      if (++count > 10000) fail("FILE_TREE_LARGE");
      const st = await fs.lstat(file);
      if (st.isSymbolicLink() || (!st.isFile() && !st.isDirectory())) fail("FILE_PATH");
      digest.update(JSON.stringify([paths.relative(full, file), st.isDirectory(), st.mode]));
      if (st.isDirectory()) {
        for (const name of (await fs.readdir(file)).sort()) {
          if (denied(name)) fail("FILE_PATH");
          await visit(paths.join(file, name));
        }
      } else {
        size += st.size;
        if (size > 128 * 1024 * 1024) fail("FILE_TREE_LARGE");
        let read = 0;
        for await (const bytes of streams.createReadStream(file)) {
          bounded();
          read += bytes.length;
          if (read > st.size) fail("FILE_CHANGED");
          digest.update(bytes);
        }
        const after = await fs.lstat(file);
        if (
          read !== st.size ||
          after.ino !== st.ino ||
          after.mtimeMs !== st.mtimeMs ||
          after.ctimeMs !== st.ctimeMs
        )
          fail("FILE_CHANGED");
      }
    };
    await visit(full);
    return {
      fingerprint: digest.digest("hex"),
      kind: (await fs.stat(full)).isDirectory() ? "directory" : "file",
      size,
    };
  };
  // A completed move/delete receipt remains readable when its source no longer exists.
  const full = await scoped(request.path, !["read", "stat"].includes(request.op));
  if (request.op === "import-check") {
    if (!(await fs.stat(paths.dirname(full))).isDirectory()) fail("FILE_PATH");
    try {
      await fs.lstat(full);
      if (!request.fingerprint) fail("FILE_EXISTS");
      const existing = await fingerprint(full);
      if (existing.kind !== "file" || existing.fingerprint !== request.fingerprint)
        fail("FILE_CHANGED");
      return { path: request.path, ...existing };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      if (request.fingerprint) fail("FILE_CHANGED");
    }
    return { path: request.path, kind: "file", size: 0, fingerprint: "" };
  }
  if (request.op === "stat") return { path: request.path, ...(await fingerprint(full)) };
  const textFile = async () => {
    const st = await fs.stat(full);
    if (!st.isFile() || st.size > 2 * 1024 * 1024) fail("FILE_TEXT_SIZE");
    const reader = await fs.open(
      full,
      streams.constants.O_RDONLY | (streams.constants.O_NOFOLLOW ?? 0),
    );
    let bytes: Buffer;
    try {
      if ((await reader.stat()).ino !== st.ino) fail("FILE_CHANGED");
      const chunks: Buffer[] = [];
      let size = 0;
      for (;;) {
        bounded();
        const chunk = Buffer.alloc(65536);
        const { bytesRead } = await reader.read(chunk);
        if (!bytesRead) break;
        size += bytesRead;
        if (size > 2 * 1024 * 1024) fail("FILE_TEXT_SIZE");
        chunks.push(chunk.subarray(0, bytesRead));
      }
      bytes = Buffer.concat(chunks, size);
    } finally {
      await reader.close();
    }
    if (bytes.length > 2 * 1024 * 1024) fail("FILE_TEXT_SIZE");
    if (bytes.includes(0)) fail("FILE_ENCODING");
    const bom = bytes.subarray(0, 3).equals(Buffer.from([239, 187, 191]));
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return fail("FILE_ENCODING");
    }
    if (Buffer.byteLength(text, "utf8") > 2 * 1024 * 1024) fail("FILE_TEXT_SIZE");
    const after = await fs.stat(full);
    if (
      st.mtimeMs !== after.mtimeMs ||
      st.ctimeMs !== after.ctimeMs ||
      st.size !== after.size ||
      st.ino !== after.ino
    )
      fail("FILE_CHANGED");
    const fingerprint = crypto
      .createHash("sha256")
      .update(JSON.stringify(["", false, st.mode]))
      .update(bytes)
      .digest("hex");
    return {
      path: request.path,
      fingerprint,
      kind: "file" as const,
      size: bytes.length,
      text,
      bom,
    };
  };
  if (request.op === "read") return textFile();
  const importing = request.op === "import";
  if (
    importing &&
    (!upload ||
      !paths.isAbsolute(upload.path) ||
      !Number.isSafeInteger(upload.bytes) ||
      upload.bytes < 0 ||
      !/^[a-f0-9]{64}$/.test(upload.sha256))
  )
    fail("FILE_REQUEST");
  const importedFile = async (file: string): Promise<FileSnapshot> => {
    const st = await fs.lstat(file);
    if (!st.isFile() || st.isSymbolicLink() || st.size !== upload!.bytes) fail("FILE_INTEGRITY");
    const digest = crypto.createHash("sha256"),
      fingerprint = crypto.createHash("sha256").update(JSON.stringify(["", false, st.mode]));
    let size = 0;
    for await (const bytes of streams.createReadStream(file)) {
      bounded();
      size += bytes.length;
      if (size > upload!.bytes) fail("FILE_INTEGRITY");
      digest.update(bytes);
      fingerprint.update(bytes);
    }
    const after = await fs.lstat(file);
    if (
      size !== upload!.bytes ||
      digest.digest("hex") !== upload!.sha256 ||
      st.ino !== after.ino ||
      st.mtimeMs !== after.mtimeMs ||
      st.ctimeMs !== after.ctimeMs
    )
      fail("FILE_INTEGRITY");
    return { path: request.path, kind: "file", size, fingerprint: fingerprint.digest("hex") };
  };
  if (!request.id || !/^[a-f0-9-]{36}$/.test(request.id)) fail("FILE_REQUEST");
  const state = paths.join(
    receiptRoot ?? paths.join(os.homedir(), ".codex-web", "file-operations"),
    hash(base),
  );
  await fs.mkdir(state, { recursive: true, mode: 0o700 });
  const receipt = paths.join(state, request.id + ".json"),
    signature = hash(
      JSON.stringify(importing ? [request, upload!.bytes, upload!.sha256] : request),
    );
  const savedText = await fs.readFile(receipt, "utf8").catch((e) => {
    if (e.code === "ENOENT") return null;
    throw e;
  });
  let resumeImport = false;
  if (savedText) {
    const saved = JSON.parse(savedText);
    if (saved.signature !== signature) fail("FILE_REQUEST");
    if (saved.result) {
      if (importing) await fs.unlink(upload!.path).catch(() => {});
      return saved.result;
    }
    if (request.op === "save") {
      const current = await textFile().catch(() => null);
      if (current && current.text === request.text && current.bom === !!request.bom) return current;
    }
    if (importing) {
      try {
        const result = await importedFile(full);
        await fs.unlink(upload!.path).catch(() => {});
        return result;
      } catch (e) {
        if (
          (e as NodeJS.ErrnoException).code !== "ENOENT" &&
          (!request.fingerprint || (await fingerprint(full)).fingerprint !== request.fingerprint)
        )
          fail("FILE_UNKNOWN");
        resumeImport = true;
      }
    } else fail("FILE_UNKNOWN");
  }
  const lock = paths.join(state, "lock");
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(lock, "wx", 0o600);
  } catch {
    // Only one process may reclaim a dead owner's lock. Without this claim,
    // competing recoveries could unlink a newly acquired live lock.
    let recovery: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      recovery = await fs.open(lock + ".recovery", "wx", 0o600);
      const pid = Number(await fs.readFile(lock, "utf8"));
      if (!Number.isSafeInteger(pid) || pid <= 0) fail("FILE_BUSY");
      try {
        process.kill(pid, 0);
        return fail("FILE_BUSY");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
      }
      await fs.unlink(lock);
      handle = await fs.open(lock, "wx", 0o600);
    } catch {
      return fail("FILE_BUSY");
    } finally {
      if (recovery) {
        await recovery.close();
        await fs.unlink(lock + ".recovery");
      }
    }
  }
  await handle.writeFile(String(process.pid));
  const temp = paths.join(paths.dirname(full), ".codexweb-file-" + request.id);
  let receiptStarted = false;
  let effectsPossible = false;
  // Never rename over a destination. Each entry is exclusively created, including directories.
  const copyExclusive = async (from: string, to: string) => {
    bounded();
    const st = await fs.lstat(from);
    if (st.isSymbolicLink() || (!st.isFile() && !st.isDirectory())) fail("FILE_PATH");
    if (st.isDirectory()) {
      await fs.mkdir(to, { mode: 0o700 });
      for (const name of await fs.readdir(from)) {
        if (denied(name)) fail("FILE_PATH");
        await copyExclusive(paths.join(from, name), paths.join(to, name));
      }
    } else await fs.copyFile(from, to, streams.constants.COPYFILE_EXCL);
    await fs.chmod(to, st.mode & 0o777);
  };
  try {
    const creating =
      request.op === "create" || request.op === "mkdir" || (importing && !request.fingerprint);
    const before = creating ? null : await fingerprint(full);
    if (before && before.fingerprint !== request.fingerprint) fail("FILE_CHANGED");
    const target = request.target ? await scoped(request.target, true) : undefined;
    if (target && (target === full || target.startsWith(full + paths.sep))) fail("FILE_PATH");
    if (target || creating) {
      try {
        await fs.lstat(target ?? full);
        fail("FILE_EXISTS");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
    }
    if (request.op === "save") {
      if (before?.kind !== "file") fail("FILE_REQUEST");
      await textFile();
    }
    if (
      (request.op === "save" || request.op === "create") &&
      Buffer.byteLength(request.text ?? "", "utf8") > 2 * 1024 * 1024
    )
      fail("FILE_TEXT_SIZE");
    if (
      (request.op === "save" || request.op === "create") &&
      (typeof request.text !== "string" || request.text.includes("\0"))
    )
      fail("FILE_ENCODING");
    if (["move", "copy"].includes(request.op) && !target) fail("FILE_REQUEST");
    if (!resumeImport)
      await fs.writeFile(receipt, JSON.stringify({ signature }), {
        flag: "wx",
        mode: 0o600,
        flush: true,
      });
    receiptStarted = true;
    if (importing) {
      if (before && before.kind !== "file") fail("FILE_PATH");
      if (resumeImport)
        await fs.unlink(temp).catch((e) => {
          if (e.code !== "ENOENT") throw e;
        });
      await importedFile(upload!.path);
      const disk = await fs.statfs(paths.dirname(full));
      if (disk.bavail * disk.bsize < upload!.bytes + 1048576) fail("ENOSPC");
      await fs.copyFile(upload!.path, temp, streams.constants.COPYFILE_EXCL);
      if (before) await fs.chmod(temp, (await fs.stat(full)).mode & 0o777);
      await importedFile(temp);
      const f = await fs.open(temp, "r+");
      try {
        await f.sync();
      } finally {
        await f.close();
      }
      await scoped(request.path, creating);
      if (before && (await fingerprint(full)).fingerprint !== before.fingerprint)
        fail("FILE_CHANGED");
      // Hard link commits the complete, verified sibling atomically and never replaces a name.
      try {
        if (before) {
          effectsPossible = true;
          await fs.rename(temp, full);
        } else {
          await fs.link(temp, full);
          effectsPossible = true;
        }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") fail("FILE_EXISTS");
        throw e;
      }
      if (!before) await fs.unlink(temp);
    } else if (request.op === "save" || request.op === "create") {
      const bytes = Buffer.concat([
        request.bom ? Buffer.from([239, 187, 191]) : Buffer.alloc(0),
        Buffer.from(request.text ?? "", "utf8"),
      ]);
      if (bytes.length > 2 * 1024 * 1024) fail("FILE_TEXT_SIZE");
      if (Buffer.from(request.text ?? "", "utf8").toString("utf8") !== request.text)
        fail("FILE_ENCODING");
      const f = await fs.open(temp, "wx", before ? (await fs.stat(full)).mode : 0o666);
      try {
        await f.writeFile(bytes);
        if (before) await f.chmod((await fs.stat(full)).mode & 0o777);
        await f.sync();
      } finally {
        await f.close();
      }
      await scoped(request.path, creating);
      if (before && (await fingerprint(full)).fingerprint !== before.fingerprint) {
        await fs.unlink(receipt);
        fail("FILE_CHANGED");
      }
      if (creating) {
        effectsPossible = true;
        await fs.link(temp, full);
        await fs.unlink(temp);
      } else {
        effectsPossible = true;
        await fs.rename(temp, full);
      }
      if (!(await fs.readFile(full)).equals(bytes)) fail("FILE_CHANGED");
    } else if (request.op === "mkdir") {
      effectsPossible = true;
      await fs.mkdir(full);
    } else if ((request.op === "copy" || request.op === "move") && target) {
      await scoped(request.path);
      await scoped(request.target!, true);
      if ((await fingerprint(full)).fingerprint !== before!.fingerprint) fail("FILE_CHANGED");
      effectsPossible = true;
      await copyExclusive(full, target);
      if (
        (await fingerprint(target)).fingerprint !== before!.fingerprint ||
        (await fingerprint(full)).fingerprint !== before!.fingerprint
      )
        fail("FILE_CHANGED");
    }
    if (request.op === "delete" || request.op === "move") {
      await scoped(request.path);
      if ((await fingerprint(full)).fingerprint !== before!.fingerprint) fail("FILE_CHANGED");
      // Capture the source in a private, exclusively allocated sibling before removal.
      // If it changed during capture, restore without overwriting new external files.
      const quarantine = await fs.mkdtemp(paths.join(paths.dirname(full), ".codexweb-file-"));
      const captured = paths.join(quarantine, "source");
      effectsPossible = true;
      await fs.writeFile(receipt + ".tmp", JSON.stringify({ signature, quarantine }), {
        mode: 0o600,
        flush: true,
      });
      await fs.rename(receipt + ".tmp", receipt);
      await fs.rename(full, captured);
      if ((await fingerprint(captured)).fingerprint !== before!.fingerprint) {
        await copyExclusive(captured, full).catch(() => {});
        // Keep captured bytes for recovery; no recursive deletion after a conflict.
        fail("FILE_CHANGED");
      }
      await fs.rm(quarantine, { recursive: true });
    }
    const result: FileSnapshot =
      request.op === "delete"
        ? { path: request.path, fingerprint: "", kind: before!.kind, size: 0 }
        : importing
          ? await importedFile(full)
          : { path: request.target ?? request.path, ...(await fingerprint(target ?? full)) };
    await fs.writeFile(receipt + ".tmp", JSON.stringify({ signature, result }), {
      mode: 0o600,
      flush: true,
    });
    await fs.rename(receipt + ".tmp", receipt);
    return result;
  } catch (error) {
    // Preserve receipts after possible effects. A later attempt must reconcile, never replay.
    if (effectsPossible) fail("FILE_UNKNOWN");
    if (receiptStarted) await fs.unlink(receipt).catch(() => {});
    if ((error as NodeJS.ErrnoException).code === "EEXIST") fail("FILE_EXISTS");
    throw error;
  } finally {
    if (importing) await fs.unlink(upload!.path).catch(() => {});
    await fs.rm(temp, { force: true }).catch(() => {});
    await handle.close();
    await fs.unlink(lock);
  }
}
