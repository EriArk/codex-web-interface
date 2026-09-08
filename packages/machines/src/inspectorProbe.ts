import type { InspectRequest, ProjectDiff, ProjectDirectory, ProjectGit } from "@codex-web/shared";

// Self-contained: the compiled function also executes in the configured Windows Node runtime.
export async function inspectorProbe(
  root: string,
  request: InspectRequest,
): Promise<ProjectDirectory | ProjectGit | ProjectDiff | { path: string }> {
  const fs = await import("node:fs/promises"),
    paths = await import("node:path"),
    cp = await import("node:child_process");
  const denied = (value: string) =>
    Array.from(value).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
    value
      .split(/[\\/]/)
      .some(
        (p) =>
          p === ".." ||
          /^(?:\.git|\.ssh|\.codex|\.aws|\.azure|\.gnupg|\.npmrc|\.pypirc|auth\.json|credentials(?:\..*)?|id_(?:rsa|ed25519|ecdsa)(?:\..*)?|\.env(?:\..*)?)$/i.test(
            p,
          ) ||
          /\.(?:pem|key|p12|pfx)$/i.test(p),
      );
  const inside = (parent: string, file: string) => {
    const rel = paths.relative(parent, file);
    return rel !== ".." && !rel.startsWith(".." + paths.sep) && !paths.isAbsolute(rel);
  };
  const fail = () => {
    throw Error("INVALID_PROJECT_PATH");
  };
  if (!paths.isAbsolute(root)) fail();
  let ancestor = paths.resolve(root);
  while (true) {
    if ((await fs.lstat(ancestor)).isSymbolicLink()) fail();
    const parent = paths.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const actualRoot = await fs.realpath(root);
  const relative = (file: string) => paths.relative(actualRoot, file).split(paths.sep).join("/");
  const scoped = async (value: string, missing = false) => {
    if (
      value.length > 2048 ||
      Array.from(value).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
      value.includes(":") ||
      value.includes("\\") ||
      paths.isAbsolute(value) ||
      denied(value)
    )
      fail();
    const file = paths.resolve(actualRoot, value);
    if (!inside(actualRoot, file)) fail();
    let cursor = file;
    while (cursor !== actualRoot) {
      try {
        if ((await fs.lstat(cursor)).isSymbolicLink()) fail();
      } catch (e) {
        if (!(missing && (e as NodeJS.ErrnoException).code === "ENOENT")) throw e;
      }
      cursor = paths.dirname(cursor);
    }
    const real = missing ? file : await fs.realpath(file);
    if (!inside(actualRoot, real)) fail();
    return real;
  };
  if (request.op === "file") {
    const file = await scoped(request.path),
      stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > 33554432) fail();
    return { path: relative(file) };
  }
  if (request.op === "directory") {
    const directory = await scoped(request.path),
      entries = [];
    let scanned = 0;
    const deadline = Date.now() + 10000;
    const stream = await fs.opendir(directory);
    for await (const entry of stream) {
      if (++scanned > 5000) break;
      if (Date.now() > deadline) throw Error("DIRECTORY_TIMEOUT");
      if (
        denied(entry.name) ||
        entry.isSymbolicLink() ||
        (!entry.isDirectory() && !entry.isFile()) ||
        !entry.name.toLowerCase().includes(request.search.toLowerCase())
      )
        continue;
      const full = paths.join(directory, entry.name);
      // Revalidate entries; repositories can change while Codex works.
      try {
        const stat = await fs.lstat(full);
        if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) continue;
        entries.push({
          name: entry.name,
          path: relative(full),
          kind: stat.isDirectory() ? ("directory" as const) : ("file" as const),
          size: stat.size,
          modifiedAt: stat.mtimeMs,
        });
      } catch {
        /* A removed entry is omitted. */
      }
    }
    entries.sort(
      (a, b) =>
        (a.kind === b.kind ? 0 : a.kind === "directory" ? -1 : 1) ||
        a.name.localeCompare(b.name, "ru"),
    );
    return {
      path: relative(directory),
      entries: entries.slice(request.offset, request.offset + 100),
      nextOffset: entries.length > request.offset + 100 ? request.offset + 100 : null,
      truncated: scanned > 5000,
    };
  }
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")),
  );
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_PAGER = "cat";
  env.LC_ALL = "C.UTF-8";
  let executable = "";
  for (const directory of (process.env.PATH ?? process.env.Path ?? "").split(paths.delimiter)) {
    if (!paths.isAbsolute(directory)) continue;
    try {
      const candidate = await fs.realpath(
        paths.join(directory, process.platform === "win32" ? "git.exe" : "git"),
      );
      if (!inside(actualRoot, candidate) && (await fs.stat(candidate)).isFile()) {
        executable = candidate;
        break;
      }
    } catch {
      /* Try the next configured executable directory. */
    }
  }
  if (!executable) throw Error("GIT_UNAVAILABLE");
  const git = (
    args: string[],
    limit = 524288,
    truncated = false,
  ): Promise<{ code: number; text: string; truncated: boolean; notRepository: boolean }> =>
    new Promise((resolve, reject) => {
      const child = cp.spawn(
        executable,
        [
          "--no-pager",
          "--no-optional-locks",
          "--literal-pathspecs",
          "-c",
          "core.fsmonitor=false",
          "-c",
          "log.showSignature=false",
          ...args,
        ],
        { cwd: actualRoot, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
      );
      const chunks: Buffer[] = [];
      let size = 0,
        overflow = false,
        done = false,
        stderr = "";
      const finish = (code: number) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (child.exitCode === null) child.kill();
        if (overflow && !truncated) return reject(Error("GIT_OUTPUT_LIMIT"));
        resolve({
          code: overflow && truncated ? 0 : code,
          text: Buffer.concat(chunks, size).toString("utf8"),
          truncated: overflow,
          notRepository: stderr.includes("not a git repository (or any of the parent directories)"),
        });
      };
      const timer = setTimeout(() => {
        if (done) return;
        child.kill();
        finish(124);
      }, 10000);
      child.stdout.on("data", (b: Buffer) => {
        const part = b.subarray(0, Math.max(0, limit - size));
        chunks.push(part);
        size += part.length;
        if (b.length > part.length) {
          overflow = true;
          finish(0);
        }
      });
      child.stderr.on("data", (b: Buffer) => {
        stderr = (stderr + b.toString("utf8")).slice(0, 2048);
      });
      child.on("error", () => finish(127));
      child.on("close", (code) => finish(code ?? 1));
    });
  const top = await git(["rev-parse", "--show-toplevel"]);
  if (top.code !== 0) {
    // A non-repository is a normal result; missing Git/timeouts remain failures.
    if (!top.notRepository) throw Error("GIT_UNAVAILABLE");
    if (request.op === "git") return { repository: false, changes: [], commits: [] };
    throw Error("NOT_A_REPOSITORY");
  }
  const gitRoot = await fs.realpath(top.text.trim());
  if (!inside(gitRoot, actualRoot)) fail();
  const gitPath = (value: string) => {
    const full = paths.resolve(gitRoot, value);
    return inside(actualRoot, full) && !denied(relative(full)) ? relative(full) : null;
  };
  if (request.op === "diff") {
    await scoped(request.path, true);
    const result = await git(
      [
        "diff",
        ...(request.staged ? ["--cached"] : []),
        "--no-ext-diff",
        "--no-textconv",
        "--ignore-submodules=all",
        "--no-color",
        "--",
        request.path,
      ],
      262144,
      true,
    );
    if (result.code !== 0) throw Error("GIT_DIFF_FAILED");
    return {
      path: request.path,
      staged: request.staged,
      text: result.text,
      truncated: result.truncated,
    };
  }
  const [status, log, workingStat, stagedStat] = await Promise.all([
    git([
      "status",
      "--porcelain=v1",
      "-z",
      "--branch",
      "--untracked-files=all",
      "--ignore-submodules=all",
      "--",
      ".",
    ]),
    git([
      "log",
      "-12",
      "--no-show-signature",
      "--no-decorate",
      "--format=%h%x00%s%x00%cI",
      "--",
      ".",
    ]),
    git([
      "diff",
      "--shortstat",
      "--no-ext-diff",
      "--no-textconv",
      "--ignore-submodules=all",
      "--",
      ".",
    ]),
    git([
      "diff",
      "--cached",
      "--shortstat",
      "--no-ext-diff",
      "--no-textconv",
      "--ignore-submodules=all",
      "--",
      ".",
    ]),
  ]);
  if (status.code !== 0) throw Error("GIT_STATUS_FAILED");
  let stagedCount = 0,
    workingCount = 0,
    untrackedCount = 0,
    hiddenCount = 0;
  const records = status.text.split("\0"),
    header = records.shift() ?? "",
    changes: ProjectGit["changes"] = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i] ?? "";
    if (record.length < 4) continue;
    const index = record.charAt(0),
      working = record.charAt(1),
      path = gitPath(record.slice(3));
    const previous = /[RC]/.test(index + working) ? gitPath(records[++i] ?? "") : null;
    if (index === "?") untrackedCount++;
    else {
      if (index !== " ") stagedCount++;
      if (working !== " ") workingCount++;
    }
    if (!path) hiddenCount++;
    if (path)
      changes.push({
        path: record.endsWith("/") ? `${path}/` : path,
        index,
        working,
        ...(previous ? { previousPath: previous } : {}),
      });
  }
  const commits: ProjectGit["commits"] = [];
  if (log.code === 0)
    for (const line of log.text.trimEnd().split("\n")) {
      const [id, subject, date] = line.split("\0");
      if (id && date && subject !== undefined) commits.push({ id, subject, date });
    }
  else if (log.code !== 128) throw Error("GIT_LOG_FAILED");
  const branch =
    header.replace(/^## (?:No commits yet on |Initial commit on )?/, "").split(/\.\.\.| \[/)[0] ??
    "";
  if (workingStat.code !== 0 || stagedStat.code !== 0) throw Error("GIT_SUMMARY_FAILED");
  const stat = (text: string) => ({
    files: Number(text.match(/(\d+) files? changed/)?.[1] ?? 0),
    added: Number(text.match(/(\d+) insertions?/)?.[1] ?? 0),
    removed: Number(text.match(/(\d+) deletions?/)?.[1] ?? 0),
  });
  return {
    repository: true,
    dirty: stagedCount + workingCount + untrackedCount > 0,
    stagedCount,
    workingCount,
    untrackedCount,
    hiddenCount,
    summary: { staged: stat(stagedStat.text), working: stat(workingStat.text) },
    branch,
    detached: branch.startsWith("HEAD"),
    ahead: Number(header.match(/ahead (\d+)/)?.[1] ?? 0),
    behind: Number(header.match(/behind (\d+)/)?.[1] ?? 0),
    changes,
    commits,
  };
}
