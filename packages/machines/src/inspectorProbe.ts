import type {
  InspectRequest,
  ProjectDiff,
  ProjectDirectory,
  ProjectGit,
  ProjectReleases,
  ProjectRepository,
} from "@codex-web/shared";

// Self-contained: the compiled function also executes in the configured Windows Node runtime.
export async function inspectorProbe(
  root: string,
  request: InspectRequest,
): Promise<
  | ProjectDirectory
  | ProjectGit
  | ProjectDiff
  | ProjectRepository
  | ProjectReleases
  | { path: string }
  | { path: string; data: string; oid: string }
> {
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
        (request.sort === "modified"
          ? b.modifiedAt - a.modifiedAt
          : request.sort === "size"
            ? b.size - a.size
            : 0) ||
        a.name.localeCompare(b.name, "ru"),
    );
    const found = request.reveal ? entries.findIndex((e) => e.name === request.reveal) : -1;
    const offset = found >= 0 ? Math.floor(found / 100) * 100 : request.offset;
    return {
      path: relative(directory),
      offset,
      total: entries.length,
      entries: entries.slice(offset, offset + 100),
      nextOffset: entries.length > offset + 100 ? offset + 100 : null,
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
  const findExecutable = async (name: string) => {
    for (const directory of (process.env.PATH ?? process.env.Path ?? "").split(paths.delimiter)) {
      if (!paths.isAbsolute(directory)) continue;
      try {
        const candidate = await fs.realpath(
          paths.join(directory, process.platform === "win32" ? name + ".exe" : name),
        );
        if (!inside(actualRoot, candidate) && (await fs.stat(candidate)).isFile()) {
          return candidate;
        }
      } catch {
        /* Try the next configured executable directory. */
      }
    }
    return "";
  };
  const executable = await findExecutable("git");
  if (!executable) throw Error("GIT_UNAVAILABLE");
  const git = (
    args: string[],
    limit = 524288,
    truncated = false,
    encoding: BufferEncoding = "utf8",
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
          text: Buffer.concat(chunks, size).toString(encoding),
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

  if (request.op === "project-rules") {
    const file = await scoped("CODEXWEB.md", true),
      marker = "<!-- CodexWeb: personal project rules -->";
    if (
      Buffer.byteLength(request.content) > 16384 ||
      (request.content && !request.content.startsWith(marker))
    )
      fail();
    const existing = await fs.readFile(file, "utf8").catch((e) => {
      if (e.code === "ENOENT") return "";
      throw e;
    });
    if (existing && !existing.startsWith(marker)) throw Error("PROJECT_RULES_UNMANAGED");
    if (!existing && !request.content) return { path: "CODEXWEB.md" };
    const tracked = await git(["ls-files", "--", "CODEXWEB.md"]);
    if (tracked.code || tracked.text.trim()) throw Error("PROJECT_RULES_TRACKED");
    if (!request.content) {
      await fs.unlink(file);
      return { path: "CODEXWEB.md" };
    }
    const top = await git(["rev-parse", "--show-toplevel"]);
    const exclude = await git([
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "info/exclude",
    ]);
    if (top.code || exclude.code) throw Error("GIT_UNAVAILABLE");
    const excludePath = exclude.text.trim();
    if (!paths.isAbsolute(excludePath)) fail();
    const stat = await fs.lstat(excludePath).catch((e) => {
      if (e.code === "ENOENT") return null;
      throw e;
    });
    if (stat?.isSymbolicLink() || (stat && !stat.isFile())) fail();
    const pattern =
      "/" +
      paths
        .relative(top.text.trim(), file)
        .split(paths.sep)
        .join("/")
        .replace(/([\\*?[\]#! ])/g, "\\$1");
    const excluded = await fs.readFile(excludePath, "utf8").catch((e) => {
      if (e.code === "ENOENT") return "";
      throw e;
    });
    if (!excluded.split(/\r?\n/).includes(pattern)) {
      await fs.mkdir(paths.dirname(excludePath), { recursive: true });
      await fs.appendFile(
        excludePath,
        `${excluded.endsWith("\n") || !excluded ? "" : "\n"}${pattern}\n`,
      );
    }
    const temp = file + "." + (await import("node:crypto")).randomUUID() + ".tmp";
    try {
      await fs.writeFile(temp, request.content, { flag: "wx" });
      await fs.rename(temp, file);
    } finally {
      await fs.unlink(temp).catch(() => {});
    }
    return { path: "CODEXWEB.md" };
  }
  if (request.op === "repository" || request.op === "releases") {
    const top = await git(["rev-parse", "--show-toplevel"]);
    if (top.code && !top.notRepository) throw Error("GIT_UNAVAILABLE");
    const repository = top.code === 0;
    let remote: ProjectRepository["remote"];
    if (repository) {
      const current = await git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
      const preferred =
        current.code === 0
          ? await git(["config", "--get", `branch.${current.text.trim()}.remote`], 4096)
          : null;
      const names = Array.from(
        new Set([preferred?.text.trim(), "origin"].filter((v): v is string => !!v && v !== ".")),
      );
      for (const name of names) {
        const config = await git(["config", "--get", `remote.${name}.url`], 8192);
        const raw = config.text.trim();
        // Return only a canonical GitHub identity, never raw config URLs or embedded credentials.
        const match =
          /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(
            raw,
          );
        if (config.code === 0 && match && ![".", ".."].includes(match[2]!)) {
          const [, owner, repo] = match;
          remote = {
            name: name.slice(0, 120),
            owner: owner!,
            repo: repo!,
            url: `https://github.com/${owner}/${repo}`,
          };
          break;
        }
      }
    }
    if (request.op === "releases") {
      const result: ProjectReleases = {
        state: remote ? "unavailable" : "no-remote",
        checkedAt: Date.now(),
        items: [],
        ...(remote ? { url: remote.url + "/releases" } : {}),
      };
      if (!remote) return result;
      const endpoint = `repos/${remote.owner}/${remote.repo}/releases?per_page=6`;
      let raw: unknown;
      const gh = await findExecutable("gh");
      let helper = "";
      if (process.platform === "win32" && process.env.LOCALAPPDATA) {
        const candidate = paths.join(
          process.env.LOCALAPPDATA,
          "CodexWeb",
          "github-releases",
          "GitHubReleases.cjs",
        );
        try {
          const st = await fs.lstat(candidate);
          if (st.isFile() && !st.isSymbolicLink() && !inside(actualRoot, candidate))
            helper = candidate;
        } catch {}
      }
      if (helper || gh) {
        // Fixed user-session reader uses Windows Credential Manager; credentials never leave Windows.
        const ghEnv = Object.fromEntries(
          Object.entries(env).filter(
            ([k]) => !/^(?:GH_DEBUG|GH_HOST|GH_REPO|GH_PAGER|PAGER)$/i.test(k),
          ),
        );
        const output = await new Promise<string | null>((resolve) => {
          const child = cp.execFile(
            helper ? process.execPath : gh,
            helper
              ? [helper, "request", remote.owner, remote.repo]
              : ["api", "--hostname", "github.com", "--method", "GET", endpoint],
            {
              cwd: actualRoot,
              env: { ...ghEnv, GH_PROMPT_DISABLED: "1", GH_HOST: "github.com" },
              windowsHide: true,
              timeout: helper ? 14000 : 8000,
              maxBuffer: 2097152,
            },
            (error, stdout) => resolve(error ? null : stdout),
          );
          child.stdin?.end();
        });
        if (output) {
          try {
            raw = JSON.parse(output);
          } catch {}
        }
      }
      if (!raw) {
        try {
          const response = await fetch("https://api.github.com/" + endpoint, {
            redirect: "error",
            signal: AbortSignal.timeout(6000),
            headers: { Accept: "application/vnd.github+json", "User-Agent": "CodexWeb" },
          });
          if (response.ok && response.body) {
            const reader = response.body.getReader(),
              chunks: Uint8Array[] = [];
            let bytes = 0;
            try {
              while (true) {
                const item = await reader.read();
                if (item.done) break;
                bytes += item.value.length;
                if (bytes > 2097152) throw Error("RELEASE_LIMIT");
                chunks.push(item.value);
              }
              raw = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            } finally {
              await reader.cancel().catch(() => {});
            }
          } else await response.body?.cancel();
        } catch {}
      }
      if (!Array.isArray(raw)) return result;
      const text = (v: unknown, limit: number) => (typeof v === "string" ? v.slice(0, limit) : "");
      for (const row of raw.slice(0, 6)) {
        if (
          !row ||
          typeof row !== "object" ||
          !Number.isSafeInteger(row.id) ||
          typeof row.tag_name !== "string"
        )
          continue;
        const url = text(row.html_url, 2048);
        if (!url.toLowerCase().startsWith(remote.url.toLowerCase() + "/releases/")) continue;
        result.items.push({
          id: String(row.id),
          name: text(row.name, 300) || text(row.tag_name, 300),
          tag: text(row.tag_name, 300),
          url,
          body: text(row.body, 12000),
          publishedAt: text(row.published_at, 40),
          prerelease: row.prerelease === true,
          draft: row.draft === true,
          assets: Array.isArray(row.assets) ? row.assets.length : 0,
          truncated: typeof row.body === "string" && row.body.length > 12000,
        });
      }
      result.state = "ok";
      return result;
    }
    const details: ProjectRepository = {
      repository,
      name: remote?.repo ?? paths.basename(actualRoot),
      remote,
      readme: null,
      branches: [],
      tags: [],
    };
    // README belongs to the configured project folder, including subprojects inside a larger Git root.
    for (const folder of ["", ".github", "docs"]) {
      try {
        const dir = await scoped(folder),
          candidates: string[] = [];
        const stream = await fs.opendir(dir);
        let scanned = 0;
        for await (const entry of stream) {
          if (++scanned > 5000) break;
          if (entry.isFile() && /^readme(?:\.(?:md|markdown|txt))?$/i.test(entry.name))
            candidates.push(entry.name);
        }
        candidates.sort(
          (a, b) => Number(!/\.md$/i.test(a)) - Number(!/\.md$/i.test(b)) || a.localeCompare(b),
        );
        if (!candidates.length) continue;
        const path = [folder, candidates[0]].filter(Boolean).join("/");
        const safePath = await scoped(path);
        const handle = await fs.open(
          safePath,
          fs.constants.O_RDONLY | (process.platform === "win32" ? 0 : fs.constants.O_NOFOLLOW),
        );
        try {
          const st = await handle.stat();
          if (!st.isFile() || (await scoped(path)) !== safePath) continue;
          const data = Buffer.alloc(131072),
            read = await handle.read(data, 0, data.length, 0);
          if (data.subarray(0, read.bytesRead).includes(0)) continue;
          details.readme = {
            path,
            text: data.subarray(0, read.bytesRead).toString("utf8"),
            truncated: st.size > read.bytesRead,
          };
        } finally {
          await handle.close();
        }
        if (details.readme) break;
      } catch {
        /* Missing/unsafe README does not prevent repository inspection. */
      }
    }
    if (repository) {
      const gitRoot = await fs.realpath(top.text.trim());
      if (!inside(gitRoot, actualRoot)) fail();
      details.subdirectory = paths.relative(gitRoot, actualRoot).split(paths.sep).join("/");
      const [branches, tags] = await Promise.all([
        git(
          [
            "for-each-ref",
            "--count=40",
            "--sort=-committerdate",
            "--format=%(HEAD)%00%(refname:short)%00%(upstream:short)",
            "refs/heads/",
          ],
          65536,
        ),
        git(
          [
            "for-each-ref",
            "--count=12",
            "--sort=-creatordate",
            "--format=%(refname:short)%00%(creatordate:iso-strict)%00%(contents:subject)",
            "refs/tags/",
          ],
          65536,
        ),
      ]);
      if (branches.code === 0)
        for (const row of branches.text.trimEnd().split("\n")) {
          const [head, name, upstream] = row.split("\0");
          if (name)
            details.branches.push({ name, current: head === "*", upstream: upstream ?? "" });
        }
      if (tags.code === 0)
        for (const row of tags.text.trimEnd().split("\n")) {
          const [name, date, subject] = row.split("\0");
          if (name) details.tags.push({ name, date: date ?? "", subject: subject ?? "" });
        }
    }
    return details;
  }

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
  if (request.op === "index-file") {
    const file = await scoped(request.path, true);
    const target = paths.relative(gitRoot, file).split(paths.sep).join("/");
    const index = await git(
      ["ls-files", "--stage", "--full-name", "-z", "--", request.path],
      32768,
    );
    const rows = index.text.split("\0").filter(Boolean);
    const match =
      rows.length === 1 ? rows[0]!.match(/^100(?:644|755) ([a-f0-9]{40,64}) 0\t([^\0]+)$/) : null;
    if (index.code || !match || match[2] !== target) fail();
    const oid = match![1]!;
    const stat = await git(["cat-file", "-s", oid], 128);
    if (stat.code || !/^\d+\s*$/.test(stat.text) || Number(stat.text) > 33554432) fail();
    const blob = await git(["cat-file", "blob", oid], 33554432, false, "base64");
    if (blob.code) fail();
    return { path: request.path, data: blob.text, oid };
  }
  if (request.op === "diff") {
    const requestedFile = await scoped(request.path, true);
    try {
      if (!(await fs.stat(requestedFile)).isFile()) fail();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const target = paths.relative(gitRoot, requestedFile).split(paths.sep).join("/");
      const [index, head] = await Promise.all([
        git(["ls-files", "--stage", "--full-name", "-z", "--", request.path], 32768),
        git(["ls-tree", "--full-name", "-z", "HEAD", "--", request.path], 32768),
      ]);
      const exactFile = [index, head].some(
        (result) =>
          result.code === 0 &&
          result.text
            .split("\0")
            .some(
              (record) =>
                /^100(?:644|755) /.test(record) &&
                record.slice(record.indexOf("\t") + 1) === target,
            ),
      );
      if (!exactFile) fail();
    }

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
      "--format=%h%x00%s%x00%cI%x00%an",
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
      const [id, subject, date, author] = line.split("\0");
      if (id && date && subject !== undefined) commits.push({ id, subject, date, author });
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
    upstream: header.match(/\.\.\.([^ []+)/)?.[1],
    detached: branch.startsWith("HEAD"),
    ahead: Number(header.match(/ahead (\d+)/)?.[1] ?? 0),
    behind: Number(header.match(/behind (\d+)/)?.[1] ?? 0),
    changes,
    commits,
  };
}
