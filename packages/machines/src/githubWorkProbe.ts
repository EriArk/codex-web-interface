import type {
  GitHubIdentity,
  GitHubRepositoryAccess,
  GitHubWorkComment,
  GitHubWorkInput,
  GitHubWorkObservation,
  GitHubWorkProbeRequest,
  GitHubWorkProbeResult,
  GitHubWorkQuery,
  GitHubWorkReceipt,
  GitHubWorkRecord,
} from "@codex-web/shared";

/** Fixed machine-local GitHub operations. Only Node built-ins may be runtime dependencies. */
export async function githubWorkProbe(
  root: string,
  request: GitHubWorkProbeRequest,
): Promise<GitHubWorkProbeResult> {
  const fs = await import("node:fs/promises"),
    path = await import("node:path"),
    os = await import("node:os"),
    cp = await import("node:child_process"),
    crypto = await import("node:crypto");
  const fail = (code: string): never => {
    throw Error(code);
  };
  const valid = (test: unknown) => {
    if (!test) fail("GITHUB_WORK_REQUEST");
  };
  const object = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === "object" && !Array.isArray(v);
  const exact = (v: unknown, fields: string[]) =>
    valid(object(v) && Object.keys(v).every((k) => fields.includes(k)));
  const text = (v: unknown, n = 2048): v is string =>
    typeof v === "string" &&
    v.length <= n &&
    !Array.from(v).some((c) => {
      const code = c.charCodeAt(0);
      return code === 127 || (code < 32 && ![9, 10, 13].includes(code));
    });
  const scalar = (v: unknown, n = 2048): v is string => text(v, n) && !/[\r\n\t]/.test(v);
  const number = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0;
  const login = (v: unknown): v is string =>
    typeof v === "string" && /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/.test(v);
  const uuid = (v: unknown): v is string =>
    typeof v === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
  const hash = (v: unknown) => crypto.createHash("sha256").update(JSON.stringify(v)).digest("hex");
  const canonical = (v: string) =>
    process.platform === "win32" ? path.resolve(v).toLowerCase() : path.resolve(v);
  const inside = (p: string, c: string) => {
    const r = path.relative(p, c);
    return r !== ".." && !r.startsWith(".." + path.sep) && !path.isAbsolute(r);
  };
  const directory = async (v: string) => {
    if (!scalar(v) || !path.isAbsolute(v) || canonical(v) === canonical(path.parse(v).root))
      fail("GITHUB_WORK_PATH");
    let p = path.resolve(v);
    while (true) {
      if ((await fs.lstat(p)).isSymbolicLink()) fail("GITHUB_WORK_PATH");
      const n = path.dirname(p);
      if (n === p) break;
      p = n;
    }
    if (!(await fs.stat(v)).isDirectory()) fail("GITHUB_WORK_PATH");
    return fs.realpath(v);
  };
  root = await directory(root);
  valid(object(request) && ["observe", "prepare", "apply", "status"].includes(request.op));
  const repository = request.repository;
  valid(
    scalar(repository, 150) &&
      /^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}\/[a-zA-Z0-9_.-]{1,100}$/.test(repository) &&
      ![".", ".."].includes(repository.split("/")[1]!),
  );
  const prefix = `repos/${repository}`,
    url = `https://github.com/${repository}`;
  const executable = async (name: string) => {
    for (const dir of (process.env.PATH ?? process.env.Path ?? "").split(path.delimiter)) {
      if (!path.isAbsolute(dir)) continue;
      try {
        const p = await fs.realpath(
          path.join(dir, name + (process.platform === "win32" ? ".exe" : "")),
        );
        if (!inside(root, p) && (await fs.stat(p)).isFile()) return p;
      } catch {}
    }
    return fail("GITHUB_WORK_UNAVAILABLE");
  };
  const env = Object.fromEntries(
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
  const run = (exe: string, args: string[], input?: unknown) =>
    new Promise<{ code: number; output: string }>((resolve) => {
      const child = cp.execFile(
        exe,
        args,
        {
          cwd: root,
          env,
          windowsHide: true,
          timeout: 25000,
          maxBuffer: 4 * 1024 * 1024,
          encoding: "utf8",
        },
        (error, output) => resolve({ code: error ? 1 : 0, output }),
      );
      child.stdin?.on("error", () => {});
      child.stdin?.end(input === undefined ? undefined : JSON.stringify(input));
    });
  const git = async (args: string[]) => {
    const r = await run(await executable("git"), ["--no-optional-locks", ...args]);
    if (r.code) fail("GITHUB_WORK_REPOSITORY");
    return r.output.trim();
  };
  if (canonical(await git(["rev-parse", "--show-toplevel"])) !== canonical(root))
    fail("GITHUB_WORK_PATH");
  const origin = await git(["config", "--get", "remote.origin.url"]);
  const matched = origin.match(
    /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([a-zA-Z0-9][a-zA-Z0-9-]{0,38}\/[a-zA-Z0-9_.-]{1,100}?)(?:\.git)?$/,
  );
  if (matched?.[1]?.toLowerCase() !== repository.toLowerCase()) fail("GITHUB_WORK_REPOSITORY");
  const gh = await executable("gh");
  const http = async (endpoint: string, method = "GET", input?: unknown) => {
    const r = await run(
      gh,
      [
        "api",
        "--hostname",
        "github.com",
        "--include",
        "--method",
        method,
        "-H",
        "Accept: application/vnd.github+json",
        "-H",
        "X-GitHub-Api-Version: 2022-11-28",
        endpoint,
        ...(input === undefined ? [] : ["--input", "-"]),
      ],
      input,
    );
    const output = r.output.replace(/\r\n/g, "\n"),
      split = output.indexOf("\n\n"),
      status = Number(output.match(/^HTTP\/[\d.]+ (\d{3})\b/)?.[1] ?? 0);
    let value: any = null;
    try {
      if (split >= 0 && output.slice(split + 2).trim()) value = JSON.parse(output.slice(split + 2));
    } catch {
      return { status: 0, value: null };
    }
    return { status: r.code && status >= 200 && status < 300 ? 0 : status, value };
  };
  const must = async (endpoint: string) => {
    const r = await http(endpoint);
    if (r.status !== 200)
      fail(
        r.status === 401
          ? "GITHUB_WORK_LOGIN"
          : r.status === 403 || r.status === 404
            ? "GITHUB_WORK_ACCESS"
            : "GITHUB_WORK_UNAVAILABLE",
      );
    return r.value;
  };
  const identity = (v: any): GitHubIdentity => {
    if (!number(v?.id) || !login(v?.login)) fail("GITHUB_WORK_DATA");
    return { id: v.id, login: v.login };
  };
  const inspect = async (): Promise<GitHubRepositoryAccess> => {
    const account = identity(await must("user")),
      response = await http(prefix),
      repo = response.value;
    if ([403, 404].includes(response.status))
      return {
        repository,
        repositoryId: null,
        identity: account,
        access: "unavailable",
        issues: false,
        checkedAt: Date.now(),
      };
    if (response.status !== 200) fail("GITHUB_WORK_UNAVAILABLE");
    if (repo?.full_name?.toLowerCase() !== repository.toLowerCase() || !number(repo?.id))
      fail("GITHUB_WORK_REPOSITORY");
    const p = repo.permissions ?? {};
    return {
      repository,
      repositoryId: repo.id,
      identity: account,
      access: p.admin
        ? "admin"
        : p.maintain
          ? "maintain"
          : p.push
            ? "write"
            : p.triage
              ? "triage"
              : "read",
      issues: repo.has_issues === true,
      checkedAt: Date.now(),
    };
  };
  const record = (v: any, type: "issue" | "pr"): GitHubWorkRecord => {
    if (
      !number(v?.number) ||
      !scalar(v.title, 1000) ||
      !["open", "closed"].includes(v.state) ||
      (typeof v.body !== "string" && v.body !== null)
    )
      fail("GITHUB_WORK_DATA");
    const raw = v.body ?? "";
    const result: GitHubWorkRecord = {
      number: v.number,
      type,
      title: v.title.slice(0, 200),
      body: raw.slice(0, 20000),
      truncated: raw.length > 20000,
      author: identity(v.user),
      state: type === "pr" && (v.merged || v.merged_at) ? "merged" : v.state,
      url: `${url}/${type === "pr" ? "pull" : "issues"}/${v.number}`,
      updatedAt: String(v.updated_at ?? "").slice(0, 50),
      createdAt: String(v.created_at ?? "").slice(0, 50),
      comments: Number.isSafeInteger(v.comments) ? v.comments : 0,
      assignees: Array.isArray(v.assignees)
        ? v.assignees
            .filter((u: any) => login(u.login))
            .slice(0, 20)
            .map((u: any) => u.login)
        : [],
      labels: Array.isArray(v.labels)
        ? v.labels
            .filter((l: any) => scalar(l.name, 100))
            .slice(0, 30)
            .map((l: any) => l.name)
        : [],
    };
    if (type === "pr" && v.head) {
      if (
        !scalar(v.head.ref, 250) ||
        !/^[a-f0-9]{40,64}$/.test(v.head.sha) ||
        !scalar(v.base?.ref, 250)
      )
        fail("GITHUB_WORK_DATA");
      result.head = {
        branch: v.head.ref,
        sha: v.head.sha,
        repository: scalar(v.head.repo?.full_name, 150) ? v.head.repo.full_name : null,
      };
      result.base = v.base.ref;
      result.draft = v.draft === true;
      result.reviewers = Array.isArray(v.requested_reviewers)
        ? v.requested_reviewers
            .filter((u: any) => login(u.login))
            .slice(0, 30)
            .map((u: any) => u.login)
        : [];
    }
    return result;
  };
  const detail = async (type: "issue" | "pr", n: number) => {
    const v = await must(`${prefix}/${type === "pr" ? "pulls" : "issues"}/${n}`);
    if (v.number !== n || (type === "issue" && v.pull_request)) fail("GITHUB_WORK_DATA");
    return record(v, type);
  };
  const comment = (v: any, n: number): GitHubWorkComment => {
    if (!number(v?.id) || !text(v?.body, 100000)) fail("GITHUB_WORK_DATA");
    return {
      id: v.id,
      author: identity(v.user),
      body: v.body.slice(0, 16000),
      truncated: v.body.length > 16000,
      createdAt: String(v.created_at ?? "").slice(0, 50),
      url: `${url}/issues/${n}#issuecomment-${v.id}`,
    };
  };
  const validateQuery = (q: GitHubWorkQuery) => {
    valid(object(q));
    if (q.kind === "identity") exact(q, ["kind"]);
    else if (q.kind === "collaborators") {
      exact(q, ["kind", "page"]);
      valid(number(q.page) && q.page <= 50);
    } else if (q.kind === "list" || q.kind === "detail") {
      exact(
        q,
        q.kind === "list"
          ? ["kind", "type", "state", "query", "page"]
          : ["kind", "type", "number", "page"],
      );
      valid(["issue", "pr"].includes(q.type) && number(q.page) && q.page <= 50);
      if (q.kind === "detail") valid(number(q.number));
      else valid(["open", "closed", "all"].includes(q.state) && scalar(q.query, 120));
    } else fail("GITHUB_WORK_REQUEST");
  };
  const observe = async (q: GitHubWorkQuery): Promise<GitHubWorkObservation> => {
    validateQuery(q);
    const access = await inspect(),
      result: GitHubWorkObservation = { ...access, query: q };
    if (q.kind === "identity") return result;
    if (access.access === "unavailable") fail("GITHUB_WORK_ACCESS");
    if (q.kind === "list") {
      // Quoted plain words cannot inject repo/org/author qualifiers or escape the bound repository.
      const words =
        q.query
          .match(/[\p{L}\p{N}_-]+/gu)
          ?.slice(0, 12)
          .map((v) => `"${v}"`)
          .join(" ") ?? "";
      const search = `repo:${repository} is:${q.type} ${q.state === "all" ? "" : "state:" + q.state} ${words}`;
      const response = await must(
        `search/issues?q=${encodeURIComponent(search)}&sort=updated&order=desc&per_page=20&page=${q.page}`,
      );
      if (!Array.isArray(response.items)) fail("GITHUB_WORK_DATA");
      result.items = response.items
        .filter(
          (v: any) =>
            v.repository_url === `https://api.github.com/${prefix}` &&
            !!v.pull_request === (q.type === "pr"),
        )
        .slice(0, 20)
        .map((v: any) => record(v, q.type));
      result.nextPage = response.items.length === 20 && q.page < 50 ? q.page + 1 : null;
    } else if (q.kind === "detail") {
      result.record = await detail(q.type, q.number);
      const list = await must(`${prefix}/issues/${q.number}/comments?per_page=20&page=${q.page}`);
      if (!Array.isArray(list)) fail("GITHUB_WORK_DATA");
      result.commentsPage = list.slice(0, 20).map((v: any) => comment(v, q.number));
      result.nextPage = list.length === 20 && q.page < 50 ? q.page + 1 : null;
      if (q.type === "pr" && result.record.head) {
        const sha = result.record.head.sha;
        const parts = await Promise.allSettled([
          must(`${prefix}/pulls/${q.number}/reviews?per_page=50`),
          must(`${prefix}/commits/${sha}/check-runs?per_page=50`),
          must(`${prefix}/commits/${sha}/status?per_page=50`),
        ]);
        const reviews = parts[0]!.status === "fulfilled" ? parts[0]!.value : null;
        if (Array.isArray(reviews))
          result.record.reviews = reviews
            .filter(
              (v) =>
                login(v.user?.login) &&
                scalar(v.state, 50) &&
                /^[a-f0-9]{40,64}$/.test(v.commit_id),
            )
            .slice(0, 50)
            .map((v) => ({ author: v.user.login, state: v.state, sha: v.commit_id }));
        result.record.checksKnown =
          parts[1]!.status === "fulfilled" && parts[2]!.status === "fulfilled";
        const checks = parts[1]!.status === "fulfilled" ? parts[1]!.value?.check_runs : null,
          statuses = parts[2]!.status === "fulfilled" ? parts[2]!.value?.statuses : null;
        result.record.checks = [
          ...(Array.isArray(checks)
            ? checks
                .filter((v) => v.head_sha === sha)
                .map((v) => ({
                  name: String(v.name).slice(0, 120),
                  state: String(v.conclusion ?? v.status).slice(0, 50),
                  sha,
                }))
            : []),
          ...(Array.isArray(statuses)
            ? statuses.map((v) => ({
                name: String(v.context).slice(0, 120),
                state: String(v.state).slice(0, 50),
                sha,
              }))
            : []),
        ].slice(0, 100);
      }
    } else if (q.kind === "collaborators") {
      if (access.access !== "admin") fail("GITHUB_WORK_ACCESS");
      const [people, invitations] = await Promise.all([
        must(`${prefix}/collaborators?per_page=20&page=${q.page}`),
        must(`${prefix}/invitations?per_page=20&page=${q.page}`),
      ]);
      if (!Array.isArray(people) || !Array.isArray(invitations)) fail("GITHUB_WORK_DATA");
      result.collaborators = [
        ...people.slice(0, 20).map((v: any) => ({
          login: identity(v).login,
          state: "accepted" as const,
          permission: String(v.role_name ?? "unknown").slice(0, 50),
        })),
        ...invitations
          .filter((v: any) => number(v.id) && login(v.invitee?.login))
          .slice(0, 20)
          .map((v: any) => ({
            login: v.invitee.login,
            state: "pending" as const,
            permission: String(v.permissions).slice(0, 50),
            invitationId: v.id,
          })),
      ];
      result.nextPage =
        (people.length === 20 || invitations.length === 20) && q.page < 50 ? q.page + 1 : null;
    }
    return result;
  };
  const validateInput = (v: GitHubWorkInput) => {
    valid(object(v));
    if (v.kind === "issue-create") {
      exact(v, ["kind", "title", "body"]);
      valid(scalar(v.title, 200) && !!v.title.trim() && text(v.body, 16000) && !!v.body.trim());
    } else if (v.kind === "comment") {
      exact(v, ["kind", "number", "type", "body"]);
      valid(
        number(v.number) &&
          ["issue", "pr"].includes(v.type) &&
          text(v.body, 16000) &&
          !!v.body.trim(),
      );
    } else if (v.kind === "issue-state") {
      exact(v, ["kind", "number", "state"]);
      valid(number(v.number) && ["open", "closed"].includes(v.state));
    } else if (v.kind === "invite") {
      exact(v, ["kind", "login", "permission"]);
      valid(login(v.login) && ["pull", "push"].includes(v.permission));
    } else if (v.kind === "remove") {
      exact(v, ["kind", "login"]);
      valid(login(v.login));
    } else if (v.kind === "request-review") {
      exact(v, ["kind", "login", "number"]);
      valid(login(v.login) && number(v.number));
    } else fail("GITHUB_WORK_REQUEST");
  };
  if (request.op === "observe") {
    exact(request, ["op", "repository", "query"]);
    return observe(request.query);
  }
  exact(
    request,
    request.op === "prepare"
      ? ["op", "repository", "id", "input"]
      : request.op === "apply"
        ? ["op", "repository", "id", "fingerprint"]
        : ["op", "repository", "id"],
  );
  valid(uuid(request.id));
  if (request.op === "prepare") validateInput(request.input);
  if (request.op === "apply")
    valid(typeof request.fingerprint === "string" && /^[a-f0-9]{64}$/.test(request.fingerprint));
  const stateRoot = path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), ".local", "share"),
    "CodexWeb",
    "github-state",
  );
  await fs.mkdir(stateRoot, { recursive: true, mode: 0o700 });
  await directory(stateRoot);
  type Saved = { root: string; repository: string; public: GitHubWorkReceipt; attempt?: number };
  const file = path.join(stateRoot, request.id + ".json"),
    lock = path.join(stateRoot, hash(repository.toLowerCase()) + ".lock");
  const read = async (): Promise<Saved | null> => {
    try {
      const s = await fs.lstat(file);
      if (!s.isFile() || s.isSymbolicLink() || s.size > 150000) fail("GITHUB_WORK_PATH");
      return JSON.parse(await fs.readFile(file, "utf8"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  };
  const write = async (v: Saved) => {
    const tmp = file + "." + crypto.randomUUID() + ".tmp",
      handle = await fs.open(tmp, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(v));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, file);
  };
  let lease: Awaited<ReturnType<typeof fs.open>>;
  try {
    lease = await fs.open(lock, "wx", 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    // Serialize stale-lock reclamation and re-read under that guard. Two stale readers
    // must never unlink a replacement acquired by the first reader. A crashed reaper
    // fails closed until maintenance; normal acquisition does not depend on the guard.
    const guardPath = lock + ".reclaim";
    const guard = await fs.open(guardPath, "wx", 0o600).catch(() => fail("GITHUB_WORK_BUSY"));
    try {
      const s = await fs.lstat(lock);
      if (!s.isFile() || s.isSymbolicLink() || s.size > 30) fail("GITHUB_WORK_BUSY");
      const pid = Number(await fs.readFile(lock, "utf8"));
      if (!number(pid)) fail("GITHUB_WORK_BUSY");
      try {
        process.kill(pid, 0);
        fail("GITHUB_WORK_BUSY");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
      }
      await fs.unlink(lock);
      lease = await fs.open(lock, "wx", 0o600).catch(() => fail("GITHUB_WORK_BUSY"));
    } finally {
      await guard.close();
      await fs.unlink(guardPath).catch(() => {});
    }
  }
  await lease.writeFile(String(process.pid));
  try {
    let saved = await read();
    if (
      saved &&
      (canonical(saved.root) !== canonical(root) ||
        saved.repository.toLowerCase() !== repository.toLowerCase())
    )
      fail("GITHUB_WORK_KEY");
    if (request.op === "prepare" && saved) {
      if (hash(saved.public.input) !== hash(request.input)) fail("GITHUB_WORK_KEY");
      return saved.public;
    }
    if (request.op !== "prepare" && !saved) return null;
    const input = request.op === "prepare" ? request.input : saved!.public.input;
    const verifyAccess = (access: GitHubRepositoryAccess, baseline?: GitHubWorkRecord) => {
      if (access.access === "unavailable" || !access.repositoryId) fail("GITHUB_WORK_ACCESS");
      if (["invite", "remove"].includes(input.kind) && access.access !== "admin")
        fail("GITHUB_WORK_ACCESS");
      if (input.kind === "issue-create" && !access.issues) fail("GITHUB_WORK_ACCESS");
      if (
        input.kind === "issue-state" &&
        !["admin", "maintain", "write", "triage"].includes(access.access) &&
        baseline?.author.id !== access.identity.id
      )
        fail("GITHUB_WORK_ACCESS");
      if (
        input.kind === "request-review" &&
        !["admin", "maintain", "write"].includes(access.access)
      )
        fail("GITHUB_WORK_ACCESS");
      if ("login" in input && input.login.toLowerCase() === access.identity.login.toLowerCase())
        fail("GITHUB_WORK_SELF");
    };
    const baseline = () =>
      "number" in input
        ? detail(
            input.kind === "request-review" || (input.kind === "comment" && input.type === "pr")
              ? "pr"
              : "issue",
            input.number,
          )
        : undefined;
    if (request.op === "prepare") {
      const files = (await fs.readdir(stateRoot)).filter((n) => /^[a-f0-9-]{36}\.json$/.test(n));
      if (files.length >= 10000) fail("GITHUB_WORK_CAPACITY");
      for (const name of files) {
        const p = path.join(stateRoot, name),
          stat = await fs.lstat(p);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 150000) fail("GITHUB_WORK_PATH");
        const prior = JSON.parse(await fs.readFile(p, "utf8")) as Saved;
        if (
          prior.repository.toLowerCase() === repository.toLowerCase() &&
          ["running", "unknown"].includes(prior.public.state)
        )
          fail("GITHUB_WORK_UNKNOWN");
      }
      const snapshot = await inspect(),
        original = await baseline();
      verifyAccess(snapshot, original);
      const receipt: GitHubWorkReceipt = {
        id: request.id,
        input,
        snapshot,
        ...(original ? { baseline: original } : {}),
        fingerprint: hash([
          canonical(root),
          repository,
          input,
          snapshot.identity,
          snapshot.repositoryId,
          original,
        ]),
        state: "prepared",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      saved = { root, repository, public: receipt };
      await write(saved);
      return receipt;
    }
    const receipt = saved!.public;
    if (request.op === "apply" && request.fingerprint !== receipt.fingerprint)
      fail("GITHUB_WORK_KEY");
    if (["completed", "failed"].includes(receipt.state)) return receipt;
    const finish = async (
      state: GitHubWorkReceipt["state"],
      code?: string,
      result?: GitHubWorkReceipt["result"],
    ) => {
      receipt.state = state;
      receipt.updatedAt = Date.now();
      if (code) receipt.code = code;
      else delete receipt.code;
      if (result) receipt.result = result;
      await write(saved!);
      return receipt;
    };
    const matchingAccount = async () => {
      const now = await inspect();
      if (
        now.identity.id !== receipt.snapshot.identity.id ||
        now.identity.login.toLowerCase() !== receipt.snapshot.identity.login.toLowerCase() ||
        now.repositoryId !== receipt.snapshot.repositoryId
      )
        fail("GITHUB_WORK_IDENTITY_CHANGED");
      verifyAccess(now, receipt.baseline);
      return now;
    };
    const marker = `<!-- codex-web:${receipt.id} -->`;
    const collaborator = async (username: string) => {
      const r = await http(`${prefix}/collaborators/${encodeURIComponent(username)}/permission`);
      if (r.status === 200 && r.value.permission !== "none")
        return { state: "accepted", id: null, permission: r.value.permission };
      if (r.status !== 404 && !(r.status === 200 && r.value.permission === "none"))
        fail("GITHUB_WORK_UNAVAILABLE");
      for (let page = 1; page <= 5; page++) {
        const list = await must(`${prefix}/invitations?per_page=100&page=${page}`);
        if (!Array.isArray(list)) fail("GITHUB_WORK_DATA");
        const v = list.find((v: any) => v.invitee?.login?.toLowerCase() === username.toLowerCase());
        if (v && number(v.id))
          return { state: "pending", id: v.id, permission: String(v.permissions) };
        if (list.length < 100) return { state: "absent", id: null, permission: "none" };
      }
      return fail("GITHUB_WORK_UNAVAILABLE");
    };
    const reconcile = async () => {
      await matchingAccount();
      if (input.kind === "invite" || input.kind === "remove") {
        const v = await collaborator(input.login);
        if (
          (input.kind === "invite" && v.state !== "absent") ||
          (input.kind === "remove" && v.state === "absent")
        )
          return finish("completed", undefined, { login: input.login, state: v.state });
      } else if (input.kind === "issue-state") {
        const v = await detail("issue", input.number);
        if (v.state === input.state)
          return finish("completed", undefined, { number: v.number, url: v.url, state: v.state });
      } else if (input.kind === "request-review") {
        const v = await detail("pr", input.number);
        if (
          v.head?.sha === receipt.baseline?.head?.sha &&
          v.reviewers?.some((v) => v.toLowerCase() === input.login.toLowerCase())
        )
          return finish("completed", undefined, {
            number: v.number,
            url: v.url,
            state: "requested",
          });
      } else {
        for (let page = 1; page <= 5; page++) {
          const list = await must(
            input.kind === "issue-create"
              ? `${prefix}/issues?state=all&sort=created&direction=desc&per_page=100&page=${page}`
              : `${prefix}/issues/${input.number}/comments?per_page=100&page=${page}`,
          );
          if (!Array.isArray(list)) fail("GITHUB_WORK_DATA");
          const matches = list.filter(
            (v: any) =>
              v.user?.id === receipt.snapshot.identity.id &&
              v.body === input.body + "\n\n" + marker &&
              (input.kind !== "issue-create" || (!v.pull_request && v.title === input.title)),
          );
          if (matches.length === 1) {
            const v = matches[0];
            if (input.kind === "issue-create") {
              const r = record(v, "issue");
              return finish("completed", undefined, {
                number: r.number,
                url: r.url,
                state: r.state,
              });
            }
            const r = comment(v, input.number);
            return finish("completed", undefined, {
              number: input.number,
              url: r.url,
              state: "commented",
            });
          }
          if (matches.length > 1 || list.length < 100) break;
        }
      }
      return finish("unknown", "GITHUB_WORK_UNKNOWN");
    };
    if (receipt.state === "running" || receipt.state === "unknown") {
      try {
        return await reconcile();
      } catch {
        return finish("unknown", "GITHUB_WORK_UNKNOWN");
      }
    }
    if (request.op === "status") return receipt;
    try {
      await matchingAccount();
      const current = await baseline();
      if (
        current &&
        (current.updatedAt !== receipt.baseline?.updatedAt ||
          current.head?.sha !== receipt.baseline?.head?.sha ||
          current.state !== receipt.baseline?.state)
      )
        fail("GITHUB_WORK_CHANGED");
      let endpoint: string, method: string, payload: unknown;
      if (input.kind === "issue-create") {
        endpoint = `${prefix}/issues`;
        method = "POST";
        payload = { title: input.title, body: input.body + "\n\n" + marker };
      } else if (input.kind === "comment") {
        endpoint = `${prefix}/issues/${input.number}/comments`;
        method = "POST";
        payload = { body: input.body + "\n\n" + marker };
      } else if (input.kind === "issue-state") {
        endpoint = `${prefix}/issues/${input.number}`;
        method = "PATCH";
        payload = { state: input.state };
      } else if (input.kind === "request-review") {
        endpoint = `${prefix}/pulls/${input.number}/requested_reviewers`;
        method = "POST";
        payload = { reviewers: [input.login] };
      } else {
        const status = await collaborator(input.login);
        if (
          (input.kind === "invite" && status.state !== "absent") ||
          (input.kind === "remove" && status.state === "absent")
        )
          return finish("completed", undefined, { login: input.login, state: status.state });
        endpoint =
          input.kind === "remove" && status.state === "pending"
            ? `${prefix}/invitations/${status.id}`
            : `${prefix}/collaborators/${input.login}`;
        method = input.kind === "invite" ? "PUT" : "DELETE";
        payload = input.kind === "invite" ? { permission: input.permission } : undefined;
      }
      saved!.attempt = Date.now();
      await finish("running");
      const response = await http(endpoint, method, payload);
      if ([400, 401, 403, 404, 409, 410, 422, 429].includes(response.status))
        return finish(
          "failed",
          response.status === 401 ? "GITHUB_WORK_LOGIN" : "GITHUB_WORK_REJECTED",
        );
      if (
        response.status >= 200 &&
        response.status < 300 &&
        (input.kind === "issue-create" || input.kind === "comment")
      ) {
        const value = response.value;
        if (
          value?.user?.id !== receipt.snapshot.identity.id ||
          value?.body !== input.body + "\n\n" + marker ||
          (input.kind === "issue-create" && value?.title !== input.title)
        )
          return finish("unknown", "GITHUB_WORK_UNKNOWN");
        if (input.kind === "issue-create") {
          const v = record(value, "issue");
          return finish("completed", undefined, { number: v.number, url: v.url, state: v.state });
        }
        if (input.kind === "comment") {
          const v = comment(value, input.number);
          return finish("completed", undefined, {
            number: input.number,
            url: v.url,
            state: "commented",
          });
        }
      }
      return await reconcile();
    } catch (error) {
      const code =
        error instanceof Error && /^GITHUB_WORK_[A-Z_]+$/.test(error.message)
          ? error.message
          : "GITHUB_WORK_UNAVAILABLE";
      return finish(saved!.attempt ? "unknown" : "failed", code);
    }
  } finally {
    await lease.close();
    await fs.unlink(lock).catch(() => {});
  }
}
