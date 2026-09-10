import type {
  DeliveryCheck,
  DeliveryGitHub,
  DeliveryInput,
  DeliveryMachineReceipt,
  DeliveryPr,
  DeliveryProbeRequest,
  DeliveryProbeResult,
  DeliveryState,
} from "@codex-web/shared";

// Installed in the fixed interactive worker. Runtime dependencies are Node built-ins only.
export async function deliveryProbe(
  root: string,
  request: DeliveryProbeRequest,
): Promise<DeliveryProbeResult> {
  const fs = await import("node:fs/promises"),
    path = await import("node:path"),
    os = await import("node:os"),
    cp = await import("node:child_process"),
    crypto = await import("node:crypto");
  const fail = (code: string): never => {
    throw Error(code);
  };
  const hash = (v: string | Buffer) => crypto.createHash("sha256").update(v).digest("hex");
  const canonical = (v: string) =>
    process.platform === "win32" ? path.resolve(v).toLowerCase() : path.resolve(v);
  const text = (v: unknown, max = 2048): v is string =>
    typeof v === "string" &&
    v.length <= max &&
    !Array.from(v).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
  const uuid = (v: unknown): v is string =>
    typeof v === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
  const inside = (parent: string, child: string) => {
    const rel = path.relative(parent, child);
    return rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel);
  };
  const safePath = (v: unknown): v is string =>
    text(v) &&
    !!v &&
    !v.includes(":") &&
    !v.includes("\\") &&
    !path.isAbsolute(v) &&
    !v
      .split("/")
      .some(
        (p) =>
          !p ||
          p === "." ||
          p === ".." ||
          /^(?:\.git|\.ssh|\.codex|\.aws|\.azure|\.gnupg|\.npmrc|\.pypirc|auth\.json|credentials(?:\..*)?|id_(?:rsa|ed25519|ecdsa)(?:\..*)?|\.env(?:\..*)?)$/i.test(
            p,
          ) ||
          /\.(?:pem|key|p12|pfx)$/i.test(p),
      );
  const checkedDirectory = async (directory: string) => {
    if (
      !text(directory) ||
      !path.isAbsolute(directory) ||
      canonical(directory) === canonical(path.parse(directory).root)
    )
      fail("DELIVERY_PATH");
    let parent = path.resolve(directory);
    while (true) {
      if ((await fs.lstat(parent)).isSymbolicLink()) fail("DELIVERY_PATH");
      const next = path.dirname(parent);
      if (next === parent) break;
      parent = next;
    }
    return fs.realpath(directory);
  };
  root = await checkedDirectory(root);
  if (!request || !["inspect", "prepare", "apply", "status"].includes(request.op))
    fail("DELIVERY_REQUEST");
  const stateRoot = path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), ".local", "share"),
    "CodexWeb",
    "delivery-state",
  );
  const ensurePrivate = async () => {
    await fs.mkdir(stateRoot, { recursive: true, mode: 0o700 });
    if ((await fs.lstat(stateRoot)).isSymbolicLink()) fail("DELIVERY_PATH");
  };
  const executable = async (name: string) => {
    for (const dir of (process.env.PATH ?? process.env.Path ?? "").split(path.delimiter)) {
      if (!path.isAbsolute(dir)) continue;
      try {
        const file = await fs.realpath(
          path.join(dir, name + (process.platform === "win32" ? ".exe" : "")),
        );
        if (!inside(root, file) && (await fs.stat(file)).isFile()) return file;
      } catch {}
    }
    return fail(name === "git" ? "GIT_UNAVAILABLE" : "GITHUB_UNAVAILABLE");
  };
  const gitExe = await executable("git"),
    env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([k]) => !/^(GIT_|GH_DEBUG$|GH_HOST$|GH_REPO$|GH_PAGER$|PAGER$)/i.test(k),
      ),
    );
  Object.assign(env, {
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GH_PROMPT_DISABLED: "1",
    GH_HOST: "github.com",
    LC_ALL: "C.UTF-8",
  });
  const run = (
    file: string,
    args: string[],
    input?: string | Buffer,
    extra: Record<string, string> = {},
    timeout = 20000,
  ) =>
    new Promise<{ code: number; out: Buffer; error: string }>((resolve) => {
      const child = cp.execFile(
        file,
        args,
        {
          cwd: root,
          env: { ...env, ...extra },
          windowsHide: true,
          timeout,
          maxBuffer: 4 * 1024 * 1024,
          encoding: "buffer",
        },
        (e, out, err) =>
          resolve({
            code: e ? (typeof e.code === "number" ? e.code : 1) : 0,
            out,
            error: err.toString("utf8"),
          }),
      );
      child.stdin?.on("error", () => {});
      child.stdin?.end(input);
    });
  const git = async (
    args: string[],
    input?: string | Buffer,
    extra: Record<string, string> = {},
    timeout = 20000,
  ) => run(gitExe, ["--no-optional-locks", ...args], input, extra, timeout);
  const must = async (
    args: string[],
    input?: string | Buffer,
    extra: Record<string, string> = {},
  ) => {
    const r = await git(args, input, extra);
    if (r.code) fail("DELIVERY_GIT_FAILED");
    return r.out.toString("utf8").trim();
  };
  const scalar = async (args: string[]) => {
    const r = await git(args);
    return r.code ? null : r.out.toString("utf8").trim();
  };
  const gh = async (endpoint: string, body?: Record<string, unknown>) => {
    const file = await executable("gh"),
      args = [
        "api",
        "--hostname",
        "github.com",
        "--method",
        body ? "POST" : "GET",
        endpoint,
        ...(body ? ["--input", "-"] : []),
      ];
    const r = await run(file, args, body ? JSON.stringify(body) : undefined, {}, 30000);
    if (r.code) fail("GITHUB_UNAVAILABLE");
    try {
      return JSON.parse(r.out.toString("utf8"));
    } catch {
      return fail("GITHUB_UNAVAILABLE");
    }
  };
  const repoFrom = (url: string | null) => {
    const match = url?.match(
      /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([a-zA-Z0-9][a-zA-Z0-9-]{0,99})\/([a-zA-Z0-9_.-]{1,100}?)(?:\.git)?$/,
    );
    return match && ![".", ".."].includes(match[2]!) ? `${match[1]}/${match[2]}` : null;
  };
  const link = (s: unknown) =>
    typeof s === "string" && /^https:\/\/github\.com\/[a-zA-Z0-9_./?#=&%-]+$/.test(s)
      ? s
      : undefined;
  const prData = (v: any, repository: string): DeliveryPr | null =>
    v &&
    Number.isSafeInteger(v.number) &&
    typeof v.title === "string" &&
    v.head?.repo?.full_name?.toLowerCase() === repository.toLowerCase() &&
    typeof v.head.ref === "string" &&
    typeof v.base?.ref === "string" &&
    /^[a-f0-9]{40,64}$/.test(v.head.sha)
      ? {
          number: v.number,
          title: v.title.slice(0, 200),
          body: String(v.body ?? "").slice(0, 20000),
          url: `https://github.com/${repository}/pull/${v.number}`,
          head: v.head.ref,
          base: v.base.ref,
          sha: v.head.sha,
          mergeable: typeof v.mergeable === "boolean" ? v.mergeable : null,
        }
      : null;
  const github = async (
    repository: string | null,
    branch: string | null,
    head: string | null,
  ): Promise<DeliveryGitHub> => {
    if (!repository) return { state: "no-remote", checks: [] };
    const base: DeliveryGitHub = {
      state: "unavailable",
      repository,
      url: `https://github.com/${repository}`,
      checks: [],
    };
    try {
      const repo = await gh(`repos/${repository}`);
      if (
        repo.full_name?.toLowerCase() !== repository.toLowerCase() ||
        !text(repo.default_branch, 200)
      )
        return base;
      base.defaultBranch = repo.default_branch;
      if (branch) {
        const remote = await git(
          ["ls-remote", "--heads", "origin", `refs/heads/${branch}`],
          undefined,
          {},
          20000,
        );
        if (remote.code) return base;
        base.remoteHead = remote.out.toString("utf8").split(/\s+/)[0] || null;
        const prs = await gh(
          `repos/${repository}/pulls?state=open&head=${encodeURIComponent(repository.split("/")[0] + ":" + branch)}&per_page=20`,
        );
        if (!Array.isArray(prs)) return base;
        const matches = prs
          .map((v) => prData(v, repository))
          .filter((p): p is DeliveryPr => !!p && p.head === branch);
        if (matches.length > 1) return base;
        if (matches[0]) base.pr = matches[0];
      }
      base.state = "ok";
      const sha = base.pr?.sha ?? base.remoteHead;
      if (sha && /^[a-f0-9]{40,64}$/.test(sha)) {
        const [checks, status] = await Promise.all([
          gh(`repos/${repository}/commits/${sha}/check-runs?per_page=50`),
          gh(`repos/${repository}/commits/${sha}/status?per_page=50`),
        ]);
        const state = (s: string): DeliveryCheck["state"] =>
          s === "success"
            ? "passed"
            : ["skipped", "neutral"].includes(s)
              ? "skipped"
              : s === "cancelled"
                ? "cancelled"
                : ["failure", "error", "timed_out", "action_required", "stale"].includes(s)
                  ? "failed"
                  : "pending";
        base.checks = [
          ...(Array.isArray(checks.check_runs) ? checks.check_runs : []).map((v: any) => ({
            name: String(v.name ?? "Check").slice(0, 160),
            state: state(v.status === "completed" ? v.conclusion : v.status),
            url: link(v.html_url),
          })),
          ...(Array.isArray(status.statuses) ? status.statuses : []).map((v: any) => ({
            name: String(v.context ?? "Status").slice(0, 160),
            state: state(v.state),
            url: link(v.target_url),
          })),
        ].slice(0, 80);
        base.checksSha = sha;
        base.checksKnown = true;
      }
      base.state = "ok";
      return base;
    } catch {
      return base;
    }
  };
  type FileSnapshot = { data: Buffer | null; mode: string };
  const inspect = async (withGithub = true) => {
    const top = await scalar(["rev-parse", "--show-toplevel"]);
    if (!top)
      return {
        state: {
          repository: false,
          branch: null,
          head: null,
          upstream: null,
          ahead: null,
          behind: null,
          changed: 0,
          staged: 0,
          untracked: 0,
          hidden: 0,
          paths: [],
          truncated: false,
          github: { state: "no-remote", checks: [] },
          checkedAt: Date.now(),
          fingerprint: "",
        } as DeliveryState,
        files: new Map<string, FileSnapshot>(),
        indexPath: "",
        indexHash: "",
        configHash: "",
        repository: null as string | null,
      };
    if (
      canonical(await fs.realpath(top)) !== canonical(root) ||
      (await scalar(["rev-parse", "--show-superproject-working-tree"]))
    )
      fail("DELIVERY_REPOSITORY_BOUNDARY");
    const branch = await scalar(["symbolic-ref", "--quiet", "--short", "HEAD"]),
      head = await scalar(["rev-parse", "--verify", "HEAD"]),
      upstream = await scalar(["rev-parse", "--abbrev-ref", "@{upstream}"]);
    const indexPath = path.resolve(root, await must(["rev-parse", "--git-path", "index"]));
    const indexStat = await fs.lstat(indexPath).catch((e) => {
      if (e.code !== "ENOENT") throw e;
      return null;
    });
    if (
      indexStat?.isSymbolicLink() ||
      (indexStat && (!indexStat.isFile() || indexStat.size > 16777216))
    )
      fail("DELIVERY_INDEX");
    const index = await fs.readFile(indexPath).catch((e) => {
        if (e.code !== "ENOENT") throw e;
        return Buffer.alloc(0);
      }),
      indexHash = hash(index);
    const configHash = hash((await git(["config", "--null", "--list"])).out),
      remote = repoFrom(await scalar(["remote", "get-url", "--all", "origin"])),
      pushRemote = repoFrom(await scalar(["remote", "get-url", "--push", "--all", "origin"]));
    const repository = remote && pushRemote?.toLowerCase() === remote.toLowerCase() ? remote : null;
    if ((await must(["ls-files", "--unmerged"])).length) fail("DELIVERY_UNMERGED");
    const status = await git([
      "-c",
      "status.renames=false",
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ]);
    if (status.code) fail("DELIVERY_GIT_FAILED");
    const rows = status.out.toString("utf8").split("\0").filter(Boolean),
      files = new Map<string, FileSnapshot>(),
      paths: DeliveryState["paths"] = [];
    const fileMode = (await scalar(["config", "--bool", "--get", "core.filemode"])) !== "false";
    let hidden = Math.max(0, rows.length - 1000),
      total = 0;
    for (const row of rows.slice(0, 1000)) {
      const relative = row.slice(3);
      if (!safePath(relative) || paths.length >= 200) {
        hidden++;
        continue;
      }
      try {
        let parent = path.dirname(path.join(root, relative));
        while (parent !== root) {
          const s = await fs.lstat(parent).catch((e) => {
            if (e.code !== "ENOENT") throw e;
            return null;
          });
          if (s?.isSymbolicLink()) throw Error();
          parent = path.dirname(parent);
        }
        const file = path.join(root, relative),
          stat = await fs.lstat(file).catch((e) => {
            if (e.code !== "ENOENT") throw e;
            return null;
          });
        if (
          stat &&
          (!stat.isFile() ||
            stat.isSymbolicLink() ||
            stat.size > 8388608 ||
            total + stat.size > 33554432)
        )
          throw Error();
        const data = stat ? await fs.readFile(file) : null;
        if (data && (data.length > 8388608 || total + data.length > 33554432)) throw Error();
        total += data?.length ?? 0;
        const stage = await scalar(["ls-files", "--stage", "--", relative]),
          mode =
            fileMode && stat && process.platform !== "win32"
              ? stat.mode & 0o111
                ? "100755"
                : "100644"
              : stage?.startsWith("100755")
                ? "100755"
                : "100644";
        if (stage && !/^100(?:644|755) /.test(stage)) throw Error();
        files.set(relative, { data, mode });
        paths.push({
          path: relative,
          index: row[0]!,
          working: row[1]!,
          size: data?.length ?? 0,
          hash: hash(data ?? "deleted"),
        });
      } catch {
        hidden++;
      }
    }
    let ahead: number | null = null,
      behind: number | null = null;
    if (upstream && head) {
      const counts = await scalar(["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]);
      if (counts) [ahead, behind] = counts.split(/\s+/).map(Number) as [number, number];
    }
    const state: DeliveryState = {
      repository: true,
      branch,
      head,
      upstream,
      ahead,
      behind,
      changed: rows.length,
      staged: rows.filter((r) => r[0] !== " " && r[0] !== "?").length,
      untracked: rows.filter((r) => r.startsWith("??")).length,
      hidden,
      paths,
      truncated: rows.length > 1000 || hidden > 0,
      github: withGithub
        ? await github(repository, branch, head)
        : {
            state: repository ? "unavailable" : "no-remote",
            ...(repository ? { repository } : {}),
            checks: [],
          },
      checkedAt: Date.now(),
      fingerprint: hash(
        JSON.stringify([
          canonical(root),
          branch,
          head,
          upstream,
          indexHash,
          configHash,
          repository,
          rows,
          paths,
          Array.from(files, ([p, f]) => [p, f.mode]),
        ]),
      ),
    };
    return { state, files, indexPath, indexHash, configHash, repository };
  };
  if (request.op === "inspect") return (await inspect()).state;
  if (!uuid(request.id)) fail("DELIVERY_REQUEST");
  await ensurePrivate();
  const file = path.join(stateRoot, request.id + ".json");
  type PrivateReceipt = {
    root: string;
    public: DeliveryMachineReceipt;
    phase: string;
    pid?: number;
    indexPath?: string;
    indexBefore?: string;
    indexAfter?: string;
    commit?: string;
    tree?: string;
    indexFile?: string;
  };
  const read = async (): Promise<PrivateReceipt | null> => {
    const stat = await fs.lstat(file).catch((e) => {
      if (e.code !== "ENOENT") throw e;
      return null;
    });
    if (!stat) return null;
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 1048576) fail("DELIVERY_RECEIPT");
    const v = JSON.parse(await fs.readFile(file, "utf8"));
    if (v.root !== canonical(root) || v.public.id !== request.id) fail("DELIVERY_RECEIPT");
    return v;
  };
  const write = async (v: PrivateReceipt, create = false) => {
    v.public.updatedAt = Date.now();
    const temp = file + "." + crypto.randomUUID() + ".tmp";
    const handle = await fs.open(temp, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(v));
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      if (create) await fs.link(temp, file);
      else await fs.rename(temp, file);
    } finally {
      await fs.unlink(temp).catch(() => {});
    }
  };
  const old = await read();
  if (request.op === "prepare") {
    const input = request.input;
    if (
      !input ||
      Buffer.byteLength(JSON.stringify(input)) > 100000 ||
      !["commit", "push", "pr"].includes(input.kind) ||
      !Array.isArray(input.paths) ||
      input.paths.length > 200 ||
      !input.paths.every(safePath) ||
      new Set(input.paths).size !== input.paths.length ||
      typeof input.message !== "string" ||
      input.message.length > 2000 ||
      input.message.includes("\0") ||
      typeof input.title !== "string" ||
      !text(input.title, 200) ||
      typeof input.body !== "string" ||
      input.body.length > 20000 ||
      input.body.includes("\0")
    )
      fail("DELIVERY_REQUEST");
    if (old) {
      if (JSON.stringify(old.public.input) !== JSON.stringify(input)) fail("DELIVERY_KEY_REUSED");
      return old.public;
    }
    const v = await inspect();
    if (!v.state.repository) fail("DELIVERY_NO_REPO");
    if (!v.state.branch) fail("DELIVERY_DETACHED");
    if (input.kind === "commit") {
      if (!input.message.trim() || !input.paths.length || input.paths.some((p) => !v.files.has(p)))
        fail("DELIVERY_SELECTION");
    } else if (!v.repository || v.state.github.state !== "ok" || !v.state.head)
      fail("DELIVERY_REMOTE");
    if (
      input.kind === "pr" &&
      (!input.title.trim() ||
        v.state.branch === v.state.github.defaultBranch ||
        v.state.github.remoteHead !== v.state.head ||
        !v.state.github.defaultBranch)
    )
      fail("DELIVERY_PR_BRANCH");
    const now = Date.now(),
      receipt: PrivateReceipt = {
        root: canonical(root),
        phase: "prepared",
        public: {
          id: request.id,
          kind: input.kind,
          state: "prepared",
          input,
          snapshot: v.state,
          fingerprint: hash(JSON.stringify([v.state.fingerprint, input])),
          createdAt: now,
          updatedAt: now,
        },
      };
    try {
      await write(receipt, true);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const winner = await read();
      if (!winner || JSON.stringify(winner.public.input) !== JSON.stringify(input))
        fail("DELIVERY_KEY_REUSED");
      return winner!.public;
    }
    return receipt.public;
  }
  if (!old) return null;
  if (request.op === "apply" && request.fingerprint !== old.public.fingerprint)
    fail("DELIVERY_CHANGED");
  if (
    ["completed", "failed"].includes(old.public.state) ||
    (request.op === "status" && old.public.state === "prepared")
  )
    return old.public;
  const live = (pid?: number) => {
    if (!pid) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code !== "ESRCH";
    }
  };
  const lockFile = path.join(stateRoot, "lock-" + hash(canonical(root)) + ".json");
  let lock: Awaited<ReturnType<typeof fs.open>>;
  try {
    lock = await fs.open(lockFile, "wx", 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    const stat = await fs.lstat(lockFile);
    if (stat.isSymbolicLink() || stat.size > 4096) fail("DELIVERY_BUSY");
    const held = JSON.parse(await fs.readFile(lockFile, "utf8"));
    if (live(held.pid)) {
      if (held.id === old.public.id) return old.public;
      return fail("DELIVERY_BUSY");
    }
    await fs.unlink(lockFile);
    lock = await fs.open(lockFile, "wx", 0o600);
  }
  await lock.writeFile(JSON.stringify({ id: old.public.id, pid: process.pid }));
  await lock.close();
  const receipt = (await read())!;
  let indexHandle: Awaited<ReturnType<typeof fs.open>> | undefined;
  const indexMarker = () => JSON.stringify({ id: receipt.public.id, pid: receipt.pid });
  const indexBytes = async (p: string) =>
    fs.readFile(p).catch((e) => {
      if (e.code !== "ENOENT") throw e;
      return Buffer.alloc(0);
    });
  const finishIndex = async () => {
    if (!receipt.indexPath || !receipt.indexFile || !receipt.indexAfter || !receipt.indexBefore)
      return fail("DELIVERY_INDEX_UNKNOWN");
    const current = hash(await indexBytes(receipt.indexPath));
    if (current === receipt.indexAfter) return;
    if (
      (await scalar(["symbolic-ref", "--quiet", "--short", "HEAD"])) !==
      receipt.public.snapshot.branch
    )
      fail("DELIVERY_INDEX_UNKNOWN");
    if (current !== receipt.indexBefore) fail("DELIVERY_INDEX_UNKNOWN");
    const pending = await fs.readFile(receipt.indexFile);
    if (hash(pending) !== receipt.indexAfter) fail("DELIVERY_INDEX_UNKNOWN");
    const lockPath = receipt.indexPath + ".lock",
      locked = await indexBytes(lockPath);
    if (
      locked.length &&
      hash(locked) !== hash(indexMarker()) &&
      hash(locked) !== receipt.indexAfter
    )
      fail("DELIVERY_INDEX_UNKNOWN");
    if (!indexHandle) indexHandle = await fs.open(lockPath, locked.length ? "r+" : "wx", 0o600);
    await indexHandle.truncate(0);
    let offset = 0;
    while (offset < pending.length) {
      const n = await indexHandle.write(pending, offset, pending.length - offset, offset);
      offset += n.bytesWritten;
    }
    await indexHandle.sync();
    await indexHandle.close();
    indexHandle = undefined;
    await fs.rename(lockPath, receipt.indexPath);
  };
  const completed = async () => {
    receipt.phase = "complete";
    receipt.public.state = "completed";
    delete receipt.public.code;
    await write(receipt);
    return receipt.public;
  };
  const reconcile = async () => {
    const s = receipt.public.snapshot;
    if (
      receipt.public.kind === "commit" &&
      !receipt.commit &&
      receipt.phase === "before-mutation"
    ) {
      const head = await scalar(["rev-parse", "--verify", `refs/heads/${s.branch}`]);
      if (
        head === s.head &&
        (!receipt.indexPath || hash(await indexBytes(receipt.indexPath)) === receipt.indexBefore)
      ) {
        receipt.public.state = "failed";
        receipt.public.code = "DELIVERY_GIT_FAILED";
        await write(receipt);
        return receipt.public;
      }
    }
    if (receipt.public.kind === "commit" && receipt.commit) {
      const head = await scalar(["rev-parse", "--verify", `refs/heads/${s.branch}`]);
      if (
        head === receipt.commit &&
        (await scalar(["rev-parse", `${receipt.commit}^{tree}`])) === receipt.tree
      ) {
        await finishIndex();
        receipt.public.commit = receipt.commit;
        return completed();
      }
      // CAS never moved this branch. No index mutation has occurred; release only our marker.
      if (
        head === s.head &&
        receipt.indexPath &&
        hash(await indexBytes(receipt.indexPath)) === receipt.indexBefore
      ) {
        receipt.public.state = "failed";
        receipt.public.code = "DELIVERY_CHANGED";
        await write(receipt);
        return receipt.public;
      }
    } else if (receipt.public.kind !== "commit" && s.github.repository) {
      if (
        repoFrom(await scalar(["remote", "get-url", "--all", "origin"]))?.toLowerCase() !==
          s.github.repository.toLowerCase() ||
        repoFrom(
          await scalar(["remote", "get-url", "--push", "--all", "origin"]),
        )?.toLowerCase() !== s.github.repository.toLowerCase()
      )
        fail("DELIVERY_REMOTE_CHANGED");
      const g = await github(s.github.repository, s.branch, s.head);
      if (g.state === "ok" && receipt.public.kind === "push" && g.remoteHead === s.head)
        return completed();
      if (
        g.pr &&
        receipt.public.kind === "pr" &&
        g.pr.head === s.branch &&
        g.pr.base === s.github.defaultBranch &&
        g.pr.sha === s.head &&
        g.pr.title === receipt.public.input.title &&
        g.pr.body === receipt.public.input.body
      ) {
        receipt.public.pr = g.pr;
        return completed();
      }
    }
    receipt.public.state = "unknown";
    receipt.public.code = "DELIVERY_UNKNOWN";
    await write(receipt);
    return receipt.public;
  };
  try {
    if (receipt.public.state !== "prepared") {
      if (live(receipt.pid) && receipt.pid !== process.pid) return receipt.public;
      return await reconcile();
    }
    if (request.op !== "apply") return receipt.public;
    const v = await inspect(false),
      s = receipt.public.snapshot,
      input = receipt.public.input;
    if (v.state.fingerprint !== s.fingerprint || !s.branch) fail("DELIVERY_CHANGED");
    receipt.public.state = "running";
    receipt.pid = process.pid;
    receipt.phase = "before-mutation";
    await write(receipt);
    if (input.kind === "commit") {
      const indexLock = v.indexPath + ".lock";
      receipt.indexPath = v.indexPath;
      receipt.indexBefore = v.indexHash;
      await write(receipt);
      const markerFile = path.join(stateRoot, request.id + ".index-marker");
      const marker = await fs.open(markerFile, "wx", 0o600);
      try {
        await marker.writeFile(indexMarker());
        await marker.sync();
      } finally {
        await marker.close();
      }
      try {
        await fs.link(markerFile, indexLock);
      } catch {
        fail("DELIVERY_INDEX_BUSY");
      } finally {
        await fs.unlink(markerFile).catch(() => {});
      }
      indexHandle = await fs.open(indexLock, "r+");
      // Snapshot selected contents into a private index. The real index retains every other staged path.
      const treeIndex = path.join(stateRoot, request.id + ".tree.index"),
        workIndex = path.join(stateRoot, request.id + ".work.index");
      const treeEnv = { GIT_INDEX_FILE: treeIndex },
        workEnv = { GIT_INDEX_FILE: workIndex };
      if (s.head) await must(["read-tree", s.head], undefined, treeEnv);
      else await must(["read-tree", "--empty"], undefined, treeEnv);
      const original = await indexBytes(v.indexPath);
      if (original.length) await fs.writeFile(workIndex, original, { flag: "wx", mode: 0o600 });
      else await must(["read-tree", "--empty"], undefined, workEnv);
      for (const selected of input.paths) {
        const item = v.files.get(selected);
        if (!item) return fail("DELIVERY_SELECTION");
        if (item.data === null) {
          await must(["update-index", "--force-remove", "--", selected], undefined, treeEnv);
          await must(["update-index", "--force-remove", "--", selected], undefined, workEnv);
        } else {
          const blob = await must(
            ["hash-object", "-w", `--path=${selected}`, "--stdin"],
            item.data,
          );
          if (!/^[a-f0-9]{40,64}$/.test(blob)) fail("DELIVERY_GIT_FAILED");
          await must(
            ["update-index", "--add", "--cacheinfo", item.mode, blob, selected],
            undefined,
            treeEnv,
          );
          await must(
            ["update-index", "--add", "--cacheinfo", item.mode, blob, selected],
            undefined,
            workEnv,
          );
        }
      }
      const tree = await must(["write-tree"], undefined, treeEnv);
      if (s.head && tree === (await scalar(["rev-parse", `${s.head}^{tree}`])))
        fail("DELIVERY_EMPTY");
      const sign = await scalar(["config", "--bool", "--get", "commit.gpgsign"]);
      const commit = await must(
        [
          "commit-tree",
          tree,
          ...(s.head ? ["-p", s.head] : []),
          ...(sign === "true" ? ["-S"] : []),
        ],
        input.message + "\n",
      );
      receipt.commit = commit;
      receipt.tree = tree;
      receipt.indexFile = workIndex;
      receipt.indexAfter = hash(await fs.readFile(workIndex));
      receipt.phase = "move-head";
      await write(receipt);
      if (
        (await scalar(["symbolic-ref", "--quiet", "--short", "HEAD"])) !== s.branch ||
        hash(await indexBytes(v.indexPath)) !== v.indexHash
      )
        fail("DELIVERY_CHANGED");
      const moved = await git([
        "update-ref",
        "-m",
        "CodexWeb checkpoint",
        `refs/heads/${s.branch}`,
        commit,
        s.head ?? "0".repeat(commit.length),
      ]);
      if (moved.code) return await reconcile();
      await finishIndex();
      receipt.public.commit = commit;
      await fs.unlink(treeIndex).catch(() => {});
      return await completed();
    }
    const current = await github(v.repository, s.branch, s.head);
    if (
      current.state !== "ok" ||
      current.repository !== s.github.repository ||
      current.remoteHead !== s.github.remoteHead
    )
      fail("DELIVERY_REMOTE_CHANGED");
    if (input.kind === "push") {
      receipt.phase = "push-started";
      await write(receipt);
      const pushed = await git(
        [
          "-c",
          "push.followTags=false",
          "-c",
          "remote.origin.mirror=false",
          "push",
          "--recurse-submodules=no",
          "origin",
          `${s.head}:refs/heads/${s.branch}`,
        ],
        undefined,
        {},
        90000,
      );
      const result = await reconcile();
      if (
        result.state !== "completed" &&
        pushed.code &&
        /\[(?:remote )?rejected\]/.test(pushed.error)
      ) {
        receipt.public.state = "failed";
        receipt.public.code = "DELIVERY_PUSH_REJECTED";
        await write(receipt);
      }
      return receipt.public;
    }
    if (current.defaultBranch !== s.github.defaultBranch || current.remoteHead !== s.head)
      fail("DELIVERY_REMOTE_CHANGED");
    if (current.pr) {
      receipt.public.pr = current.pr;
      return await completed();
    }
    receipt.phase = "pr-started";
    await write(receipt);
    await gh(`repos/${current.repository}/pulls`, {
      title: input.title,
      body: input.body,
      head: s.branch,
      base: current.defaultBranch,
    });
    return await reconcile();
  } catch (e) {
    if (
      receipt.phase === "move-head" ||
      receipt.phase === "push-started" ||
      receipt.phase === "pr-started"
    ) {
      try {
        return await reconcile();
      } catch {}
      receipt.public.state = "unknown";
      receipt.public.code = "DELIVERY_UNKNOWN";
    } else {
      receipt.public.state = "failed";
      const code = e instanceof Error ? e.message : "";
      receipt.public.code = /^(?:DELIVERY_|GIT_|GITHUB_)[A-Z_]+$/.test(code)
        ? code
        : "DELIVERY_GIT_FAILED";
    }
    await write(receipt);
    return receipt.public;
  } finally {
    await indexHandle?.close().catch(() => {});
    if (receipt.indexPath && receipt.public.state !== "unknown") {
      const p = receipt.indexPath + ".lock",
        b = await indexBytes(p);
      if (
        hash(b) === hash(indexMarker()) ||
        (receipt.public.state === "completed" && hash(b) === receipt.indexAfter)
      )
        await fs.unlink(p).catch(() => {});
    }
    await fs.unlink(lockFile).catch(() => {});
    if (["completed", "failed"].includes(receipt.public.state))
      for (const suffix of [".tree.index", ".work.index", ".index-marker"])
        await fs.unlink(path.join(stateRoot, request.id + suffix)).catch(() => {});
  }
}
