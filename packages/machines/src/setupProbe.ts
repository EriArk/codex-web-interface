import type {
  ProjectSetupInput,
  SetupInspection,
  SetupMachineReceipt,
  SetupProbeRequest,
  SetupProbeResult,
  SetupRepository,
} from "@codex-web/shared";

// Installed unchanged in the private Windows worker; all runtime dependencies are Node built-ins.
export async function setupProbe(request: SetupProbeRequest): Promise<SetupProbeResult> {
  const fs = await import("node:fs/promises"),
    p = await import("node:path"),
    os = await import("node:os"),
    crypto = await import("node:crypto"),
    cp = await import("node:child_process");
  const digest = (v: unknown) =>
    crypto.createHash("sha256").update(JSON.stringify(v)).digest("hex");
  const fail = (code: string): never => {
    throw Error(code);
  };
  const text = (v: unknown, max = 2048): v is string =>
    typeof v === "string" &&
    v.length <= max &&
    ![...v].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
  const idValid = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9-]{36}$/.test(v);
  const identity = (owner: unknown, name: unknown) =>
    typeof owner === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/.test(owner) &&
    typeof name === "string" &&
    /^[A-Za-z0-9_.-]{1,100}$/.test(name) &&
    ![".", ".."].includes(name);
  const privateRoot = p.join(
    process.env.LOCALAPPDATA || p.join(os.homedir(), ".local", "share"),
    "CodexWeb",
    "project-setup-state",
  );
  const readJson = async (file: string) => {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 262144) fail("INVALID_RECEIPT");
    return JSON.parse(await fs.readFile(file, "utf8"));
  };
  const canonical = (value: string) =>
    process.platform === "win32" ? p.resolve(value).toLowerCase() : p.resolve(value);
  const pathSafe = async (value: string) => {
    if (
      request.op !== "repositories" &&
      request.op !== "status" &&
      request.input.repository.mode === "none"
    ) {
      if (!text(value) || !p.isAbsolute(value)) fail("INVALID_PATH");
      return p.resolve(value);
    }
    if (!text(value) || !p.isAbsolute(value) || canonical(value) === canonical(p.parse(value).root))
      fail("INVALID_PATH");
    if (process.platform === "win32" && (/^\\\\/.test(value) || value.slice(2).includes(":")))
      fail("INVALID_PATH");
    let cursor = p.resolve(value);
    while (true) {
      try {
        if ((await fs.lstat(cursor)).isSymbolicLink()) fail("INVALID_PATH");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      const parent = p.dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
    return p.resolve(value);
  };
  const executable = async (name: string, root = "") => {
    for (const dir of (process.env.PATH ?? process.env.Path ?? "").split(p.delimiter)) {
      if (!p.isAbsolute(dir)) continue;
      try {
        const file = await fs.realpath(
          p.join(dir, name + (process.platform === "win32" ? ".exe" : "")),
        );
        const rel = root ? p.relative(root, file) : "..";
        if (
          (root && !p.isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + p.sep)) ||
          !(await fs.stat(file)).isFile()
        )
          continue;
        return file;
      } catch {}
    }
    return fail(name === "gh" ? "GITHUB_UNAVAILABLE" : "GIT_UNAVAILABLE");
  };
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/^(GIT_|GH_DEBUG$|GH_HOST$|GH_REPO$|GH_PAGER$|PAGER$)/i.test(key),
    ),
  );
  Object.assign(env, {
    GIT_TERMINAL_PROMPT: "0",
    GH_PROMPT_DISABLED: "1",
    GH_HOST: "github.com",
    GIT_OPTIONAL_LOCKS: "0",
    LC_ALL: "C.UTF-8",
  });
  const run = (file: string, args: string[], cwd: string, timeout = 15000) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      const child = cp.execFile(
        file,
        args,
        { cwd, env, windowsHide: true, timeout, maxBuffer: 2097152 },
        (err, stdout, stderr) =>
          resolve({
            code: err ? (typeof err.code === "number" ? err.code : 1) : 0,
            stdout,
            stderr,
          }),
      );
      child.stdin?.end();
    });
  const ghCommand = async (args: string[], root = "", timeout = 15000) =>
    run(await executable("gh", root), args, os.homedir(), timeout);
  const ghGet = async (endpoint: string, root = "") => {
    const result = await ghCommand(
      ["api", "--hostname", "github.com", "--method", "GET", endpoint],
      root,
    );
    if (result.code) {
      if (/HTTP 404|\(HTTP 404\)/.test(result.stderr)) return null;
      fail("GITHUB_UNAVAILABLE");
    }
    try {
      return JSON.parse(result.stdout);
    } catch {
      return fail("GITHUB_UNAVAILABLE");
    }
  };
  const repoData = (r: Record<string, any>): SetupRepository => {
    if (!r || !Number.isSafeInteger(r.id) || !identity(r.owner?.login, r.name))
      return fail("GITHUB_UNAVAILABLE");
    return {
      id: r.id,
      owner: r.owner.login,
      name: r.name,
      url: `https://github.com/${r.owner.login}/${r.name}`,
      private: r.private === true,
      empty: r.size === 0,
      createdAt: String(r.created_at || "").slice(0, 40),
      description: String(r.description || "").slice(0, 350),
    };
  };
  if (request.op === "repositories") {
    if (
      !text(request.search, 120) ||
      !Number.isInteger(request.page) ||
      request.page < 1 ||
      request.page > 100
    )
      fail("INVALID_REQUEST");
    const user = await ghGet("user");
    if (!user || !identity(user.login, "repo")) fail("GITHUB_UNAVAILABLE");
    const q = request.search.trim();
    const data = await ghGet(
      q
        ? `search/repositories?q=${encodeURIComponent(q)}&sort=updated&per_page=30&page=${request.page}`
        : `user/repos?sort=updated&per_page=30&page=${request.page}&affiliation=owner,collaborator,organization_member`,
    );
    const rows = q ? data?.items : data;
    if (!Array.isArray(rows)) fail("GITHUB_UNAVAILABLE");
    return { login: user.login, repositories: rows.map(repoData), hasMore: rows.length === 30 };
  }
  if (request.op === "status") {
    if (!idValid(request.id)) fail("INVALID_REQUEST");
    try {
      const row = await readJson(p.join(privateRoot, request.id + ".json"));
      return row.public;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }
  const input = request.input;
  if (
    !input ||
    !text(input.name, 120) ||
    !input.name.trim() ||
    typeof input.createDirectory !== "boolean" ||
    !input.repository ||
    !["none", "create", "connect"].includes(input.repository.mode) ||
    !text(input.repository.description, 350)
  )
    fail("INVALID_REQUEST");
  const root = await pathSafe(input.workingDirectory),
    spec = input.repository;
  if (
    spec.mode !== "none" &&
    (!identity(spec.owner, spec.name) || !["private", "public"].includes(spec.visibility))
  )
    fail("INVALID_REPOSITORY");
  const url = `https://github.com/${spec.owner}/${spec.name}`;
  const sameRemote = (raw: string) => {
    const m =
      /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(
        raw.trim(),
      );
    return !!m && `${m[1]}/${m[2]}`.toLowerCase() === `${spec.owner}/${spec.name}`.toLowerCase();
  };
  const git = async (args: string[], cwd = root, timeout = 15000) =>
    run(
      await executable("git", root),
      [
        "--no-pager",
        "--no-optional-locks",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.hooksPath=",
        "-c",
        "log.showSignature=false",
        ...args,
      ],
      cwd,
      timeout,
    );
  const local = async (): Promise<Omit<SetupInspection, "fingerprint" | "steps">> => {
    await pathSafe(root);
    const stat = await fs.stat(root).catch((e) => {
      if (e.code === "ENOENT") return null;
      throw e;
    });
    if (stat && !stat.isDirectory()) fail("DIRECTORY_REQUIRED");
    const state = {
      exists: !!stat,
      empty: true,
      git: false,
      branch: "",
      head: "",
      origin: "",
      dirty: false,
    };
    if (!stat) return state;
    const stream = await fs.opendir(root);
    for await (const _ of stream) {
      state.empty = false;
      break;
    }
    if (spec.mode === "none") return state;
    const top = await git(["rev-parse", "--show-toplevel"]);
    if (top.code) {
      if (/not a git repository/.test(top.stderr)) return state;
      return fail("GIT_UNAVAILABLE");
    }
    if (canonical(top.stdout.trim()) !== canonical(root)) fail("PARENT_REPOSITORY");
    await pathSafe(p.join(root, ".git"));
    const [branch, head, origin, status] = await Promise.all([
      git(["symbolic-ref", "--quiet", "--short", "HEAD"]),
      git(["rev-parse", "--verify", "HEAD"]),
      git(["remote", "get-url", "origin"]),
      git([
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=normal",
        "--ignore-submodules=all",
      ]),
    ]);
    if (status.code) fail("GIT_UNAVAILABLE");
    state.git = true;
    state.branch = branch.code ? "" : branch.stdout.trim();
    state.head = head.code ? "" : head.stdout.trim();
    state.dirty = !!status.stdout;
    // Never return a credential-bearing remote URL.
    state.origin = origin.code ? "" : sameRemote(origin.stdout) ? url : "other";
    return state;
  };
  const inspect = async (): Promise<SetupInspection> => {
    const state = await local(),
      steps: string[] = [];
    if (!state.exists && !input.createDirectory) fail("DIRECTORY_MISSING");
    if (input.createDirectory && state.exists && !state.empty) fail("DIRECTORY_NOT_EMPTY");
    if (!state.exists) steps.push("create-directory");
    if (spec.mode !== "none") {
      const user = await ghGet("user", root);
      if (!user || !identity(user.login, "repo")) fail("GITHUB_UNAVAILABLE");
      state.login = user.login;
      const remote = await ghGet(`repos/${spec.owner}/${spec.name}`, root);
      if (state.origin === "other") fail("REMOTE_CONFLICT");
      if (spec.mode === "create") {
        if (remote) fail("REPOSITORY_EXISTS");
        if (user.login.toLowerCase() !== spec.owner.toLowerCase()) fail("OWNER_REQUIRED");
        if (state.origin) fail("REMOTE_CONFLICT");
        if (!state.git) steps.push("git-init");
        steps.push("create-repository", "link-origin");
      } else {
        if (!remote) fail("REPOSITORY_MISSING");
        state.remote = repoData(remote);
        if (!state.git) {
          if (!state.empty) fail("DIRECTORY_NOT_EMPTY");
          steps.splice(0, steps.length, "clone");
        } else if (!state.origin) fail("UNRELATED_REPOSITORY");
      }
    }
    steps.push("register-project");
    return { ...state, steps, fingerprint: digest({ input, state, steps }) };
  };
  if (request.op === "inspect") return inspect();
  if (request.op !== "apply" || !idValid(request.id) || !/^[a-f0-9]{64}$/.test(request.fingerprint))
    fail("INVALID_REQUEST");
  await fs.mkdir(privateRoot, { recursive: true, mode: 0o700 });
  await pathSafe(privateRoot);
  const file = p.join(privateRoot, request.id + ".json");
  type Receipt = {
    hash: string;
    public: SetupMachineReceipt;
    steps: string[];
    completed: string[];
    remoteStarted?: number;
  };
  const hash = digest({ input, fingerprint: request.fingerprint });
  let receipt: Receipt | null = await readJson(file).catch((e) => {
    if (e.code === "ENOENT") return null;
    throw e;
  });
  if (receipt && receipt.hash !== hash) fail("OPERATION_CONFLICT");
  if (receipt?.public.state === "complete") return receipt.public;
  const lock = p.join(privateRoot, digest(canonical(root)) + ".lock");
  try {
    await fs.writeFile(lock, JSON.stringify({ pid: process.pid }), { flag: "wx", mode: 0o600 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    const owner = await readJson(lock);
    try {
      process.kill(owner.pid, 0);
      return fail("SETUP_BUSY");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
    }
    await fs.unlink(lock);
    await fs.writeFile(lock, JSON.stringify({ pid: process.pid }), { flag: "wx", mode: 0o600 });
  }
  const write = async () => {
    if (!receipt) return;
    receipt.public.updatedAt = Date.now();
    const temp = file + "." + crypto.randomUUID() + ".tmp";
    await fs.writeFile(temp, JSON.stringify(receipt), { flag: "wx", mode: 0o600 });
    await fs.rename(temp, file);
  };
  try {
    if (!receipt) {
      const current = await inspect();
      if (current.fingerprint !== request.fingerprint) fail("SETUP_CHANGED");
      receipt = {
        hash,
        steps: current.steps,
        completed: [],
        public: {
          id: request.id,
          state: "running",
          phase: "prepared",
          startedAt: Date.now(),
          updatedAt: Date.now(),
        },
      };
      await write();
    }
    for (const step of receipt.steps.filter((s) => s !== "register-project")) {
      if (receipt.completed.includes(step)) continue;
      const resuming = receipt.public.phase === step;
      receipt.public.state = "running";
      receipt.public.phase = step;
      delete receipt.public.error;
      await write();
      await pathSafe(root);
      if (step === "create-directory") {
        await fs.mkdir(root, { recursive: true });
        if (!(await fs.stat(root)).isDirectory()) fail("DIRECTORY_REQUIRED");
      } else if (step === "git-init") {
        if (!(await local()).git) {
          const result = await git(["init", "--initial-branch=main", "--template="]);
          if (result.code) fail("GIT_INIT_FAILED");
        }
      } else if (step === "create-repository") {
        const existing = await ghGet(`repos/${spec.owner}/${spec.name}`, root);
        if (existing) {
          const remote = repoData(existing);
          if (
            !receipt.remoteStarted ||
            Date.parse(remote.createdAt) < receipt.remoteStarted - 2000 ||
            remote.private !== (spec.visibility === "private") ||
            remote.description !== spec.description
          )
            fail("REPOSITORY_EXISTS");
          receipt.public.repository = remote;
        } else {
          if (receipt.remoteStarted || resuming) fail("CREATE_OUTCOME_UNKNOWN");
          receipt.remoteStarted = Date.now();
          await write();
          await ghCommand(
            [
              "api",
              "--hostname",
              "github.com",
              "--method",
              "POST",
              "user/repos",
              "-f",
              `name=${spec.name}`,
              "-F",
              `private=${spec.visibility === "private"}`,
              "-f",
              `description=${spec.description}`,
            ],
            root,
          );
          const verified = await ghGet(`repos/${spec.owner}/${spec.name}`, root);
          if (!verified) fail("CREATE_OUTCOME_UNKNOWN");
          const remote = repoData(verified);
          if (
            remote.private !== (spec.visibility === "private") ||
            remote.description !== spec.description
          )
            fail("REMOTE_CONFLICT");
          receipt.public.repository = remote;
        }
      } else if (step === "link-origin") {
        const state = await local();
        if (!state.git || state.origin === "other") fail("REMOTE_CONFLICT");
        if (!state.origin) {
          const result = await git(["remote", "add", "origin", url + ".git"]);
          if (result.code) fail("REMOTE_CONFLICT");
        }
        if ((await local()).origin !== url) fail("REMOTE_CONFLICT");
      } else if (step === "clone") {
        const state = await local();
        if (resuming && state.git && state.origin === url && !state.dirty) {
          receipt.completed.push(step);
          await write();
          continue;
        }
        if (state.exists && !state.empty) fail("DIRECTORY_NOT_EMPTY");
        const stage = p.join(p.dirname(root), ".codex-setup-" + request.id);
        await pathSafe(stage);
        await fs.mkdir(p.dirname(root), { recursive: true });
        const stageExists = await fs.stat(stage).then(
          () => true,
          (e) => {
            if (e.code === "ENOENT") return false;
            throw e;
          },
        );
        if (!stageExists) {
          if (resuming) fail("CLONE_OUTCOME_UNKNOWN");
          const result = await ghCommand(
            [
              "repo",
              "clone",
              `${spec.owner}/${spec.name}`,
              stage,
              "--",
              "--template=",
              "--config",
              "core.hooksPath=",
            ],
            root,
            120000,
          );
          if (result.code) fail("CLONE_OUTCOME_UNKNOWN");
        }
        const [origin, status, check, head] = await Promise.all([
          git(["remote", "get-url", "origin"], stage),
          git(["status", "--porcelain=v1", "-z"], stage),
          git(["fsck", "--no-reflogs"], stage, 30000),
          git(["rev-parse", "--verify", "HEAD"], stage),
        ]);
        if (head.code) {
          const remoteState = await ghCommand(
            ["repo", "view", `${spec.owner}/${spec.name}`, "--json", "isEmpty"],
            root,
          );
          if (remoteState.code || JSON.parse(remoteState.stdout).isEmpty !== true)
            fail("CLONE_OUTCOME_UNKNOWN");
        }
        if (origin.code || !sameRemote(origin.stdout) || status.code || status.stdout || check.code)
          fail("CLONE_OUTCOME_UNKNOWN");
        const now = await local();
        if (now.exists) {
          if (!now.empty) fail("DIRECTORY_NOT_EMPTY");
          await fs.rmdir(root);
        }
        await fs.rename(stage, root);
        const remote = await ghGet(`repos/${spec.owner}/${spec.name}`, root);
        if (remote) receipt.public.repository = repoData(remote);
      }
      receipt.completed.push(step);
      await write();
    }
    if (spec.mode !== "none") {
      const state = await local();
      if (!state.git || state.origin !== url) fail("REMOTE_CONFLICT");
    }
    receipt.public.state = "complete";
    receipt.public.phase = "register-project";
    await write();
    return receipt.public;
  } catch (e) {
    if (receipt) {
      receipt.public.state = "unknown";
      receipt.public.error = e instanceof Error ? e.message : "SETUP_FAILED";
      await write();
      return receipt.public;
    }
    throw e;
  } finally {
    await fs.unlink(lock).catch(() => {});
  }
}
