import { createHash, randomUUID } from "node:crypto";
import { authorizeMachine, deliveryMessage, runProjectGitHub } from "@codex-web/machines";
import {
  type GitHubIdentity,
  type GitHubWorkObservation,
  type GitHubWorkReceipt,
  HubError,
} from "@codex-web/shared";
import type { createApp } from "./app.js";
import type { CollaborationSpaces, Space } from "./collaboration-spaces.js";
import type { GitHubProbe } from "./team-github.js";

type Account = ({ projectId: string; repository: string } | { machineId: string }) & {
  binding: string;
  identity: GitHubIdentity;
};
type Job = {
  code?: string;
  dispatched?: boolean;
  id: string;
  spaceId: string;
  projectId: string;
  owner: string;
  userId: string;
  repository: string;
  copy: string;
  ownerEpoch: number;
  userEpoch: number;
  state:
    | "waiting-account"
    | "queued"
    | "running"
    | "pending"
    | "accepted"
    | "failed"
    | "unknown"
    | "cancelled";
  binding?: string;
  account?: Account;
  receipt?: GitHubWorkReceipt;
  acceptance?: { id: string; binding: string; receipt?: GitHubWorkReceipt };
};
const changed = () =>
  new HubError(
    409,
    "SPACE_GITHUB_CHANGED",
    "Подключение GitHub или доступ изменились. Проверь настройки проекта.",
  );
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

/** Owner-authorized outbox. A catalog read never dispatches a GitHub mutation. */
export class SpaceGitHubAccess {
  private task: Promise<void> | null = null;
  private operations = new Set<Promise<unknown>>();
  private accepting = new Set<string>();
  private stopped = false;
  constructor(
    private spaces: CollaborationSpaces,
    private personal: (id: string) => Promise<{ runtime: Awaited<ReturnType<typeof createApp>> }>,
    private probe: GitHubProbe = runProjectGitHub,
  ) {
    spaces.team.db.exec(`CREATE TABLE IF NOT EXISTS space_github_accounts(userId TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS space_github_grants(id TEXT PRIMARY KEY,spaceId TEXT NOT NULL,projectId TEXT NOT NULL,userId TEXT NOT NULL,state TEXT NOT NULL,value TEXT NOT NULL,UNIQUE(spaceId,projectId,userId));`);
    spaces.onSave = (s, old) => this.capture(s, old);
  }
  private save(j: Job, replace = false) {
    this.spaces.team.db
      .prepare(
        "INSERT INTO space_github_grants VALUES(?,?,?,?,?,?) ON CONFLICT(spaceId,projectId,userId) DO UPDATE SET id=excluded.id,state=excluded.state,value=excluded.value" +
          (replace ? "" : " WHERE space_github_grants.id=excluded.id"),
      )
      .run(j.id, j.spaceId, j.projectId, j.userId, j.state, JSON.stringify(j));
  }
  private jobs(spaceId?: string): Job[] {
    return (
      spaceId
        ? this.spaces.team.db
            .prepare("SELECT value FROM space_github_grants WHERE spaceId=?")
            .all(spaceId)
        : this.spaces.team.db.prepare("SELECT value FROM space_github_grants").all()
    ).map((r) => JSON.parse(String(r.value)));
  }
  private account(user: string): Account | null {
    const r = this.spaces.team.db
      .prepare("SELECT value FROM space_github_accounts WHERE userId=?")
      .get(user);
    return r ? JSON.parse(String(r.value)) : null;
  }
  private capture(s: Space, old: Space | null) {
    for (const p of s.projects)
      for (const [userId, access] of Object.entries(p.grants)) {
        if (
          access !== "direct" ||
          old?.projects.find((v) => v.id === p.id)?.grants[userId] === "direct"
        )
          continue;
        const prior = this.jobs(s.id).find((j) => j.projectId === p.id && j.userId === userId);
        if (prior && ["running", "unknown"].includes(prior.state)) continue;
        this.save(
          {
            id: randomUUID(),
            spaceId: s.id,
            projectId: p.id,
            owner: p.ownerId,
            userId,
            repository: p.repository.replace("https://github.com/", ""),
            copy: p.copies[p.ownerId]!,
            ownerEpoch: this.spaces.team.registry.active(p.ownerId).executionEpoch,
            userEpoch: this.spaces.team.registry.active(userId).executionEpoch,
            state: "queued",
          },
          true,
        );
      }
    for (const j of this.jobs(s.id))
      if (
        !s.projects.some((p) => p.id === j.projectId && p.grants[j.userId] === "direct") &&
        !["running", "unknown"].includes(j.state)
      ) {
        j.state = "cancelled";
        this.save(j);
      }
    // Runs after the surrounding synchronous team.once transaction commits.
    this.kick();
  }
  private scope(actor: string, spaceId: string) {
    try {
      return this.spaces.access(actor, spaceId);
    } catch {
      const row = this.spaces.team.db
        .prepare("SELECT data FROM collaboration_spaces WHERE id=?")
        .get(spaceId);
      if (!row) throw changed();
      const s = JSON.parse(String(row.data)) as Space;
      return this.spaces.invitation(actor, spaceId, s.revision).space;
    }
  }
  private allowed(j: Job) {
    if (
      this.spaces.team.db
        .prepare("SELECT id FROM space_github_grants WHERE spaceId=? AND projectId=? AND userId=?")
        .get(j.spaceId, j.projectId, j.userId)?.id !== j.id
    )
      throw changed();
    const s = this.spaces.access(j.owner, j.spaceId),
      p = s.projects.find((p) => p.id === j.projectId);
    if (
      !p ||
      p.ownerId !== j.owner ||
      p.copies[j.owner] !== j.copy ||
      p.repository !== `https://github.com/${j.repository}` ||
      p.grants[j.userId] !== "direct" ||
      ![...s.members, ...s.invitations.map((i) => i.userId)].includes(j.userId) ||
      this.spaces.team.registry.active(j.owner).executionEpoch !== j.ownerEpoch ||
      this.spaces.team.registry.active(j.userId).executionEpoch !== j.userEpoch
    )
      throw changed();
    return p;
  }
  private async context(user: string, projectId: string, repository: string) {
    const epoch = this.spaces.team.registry.active(user).executionEpoch;
    const { runtime } = await this.personal(user),
      p = runtime.sessions.project(projectId);
    runtime.projectWork.context.assertProject({ client: "codex", projectId, name: p.name });
    const machine = runtime.sessions.catalog.machine(p.machineId);
    authorizeMachine(machine);
    return {
      machine,
      root: p.workingDirectory,
      repository,
      binding: hash([user, epoch, projectId, repository, p.workingDirectory, machine]),
    };
  }
  private async observeAccount(user: string, a: Account) {
    const c = await this.accountContext(user, a);
    if (c.binding !== a.binding) throw changed();
    const v = (await this.probe(c.machine, c.root, {
      op: "observe",
      repository: c.repository,
      query: { kind: "identity" },
    })) as GitHubWorkObservation;
    if (
      v.identity.id !== a.identity.id ||
      v.identity.login.toLowerCase() !== a.identity.login.toLowerCase() ||
      (await this.accountContext(user, a)).binding !== a.binding
    )
      throw changed();
    return c;
  }
  private async machineContext(user: string, machineId: string) {
    const epoch = this.spaces.team.registry.active(user).executionEpoch;
    const { runtime } = await this.personal(user);
    const machine = runtime.sessions.catalog.machine(machineId);
    authorizeMachine(machine);
    return {
      machine,
      root: null,
      repository: "",
      binding: hash([user, epoch, "github-account", machine]),
    };
  }
  private accountContext(user: string, a: Account) {
    return "machineId" in a
      ? this.machineContext(user, a.machineId)
      : this.context(user, a.projectId, a.repository);
  }
  async connectMachine(user: string, machineId: string, expected?: GitHubIdentity) {
    const c = await this.machineContext(user, machineId);
    const v = (await this.probe(c.machine, null, {
      op: "observe",
      repository: "",
      query: { kind: "identity" },
    })) as GitHubWorkObservation;
    if (!v?.identity?.id || (await this.machineContext(user, machineId)).binding !== c.binding)
      throw changed();
    if (expected) {
      if (expected.id !== v.identity.id || expected.login !== v.identity.login) throw changed();
      this.confirm(user, { machineId, binding: c.binding, identity: v.identity });
    }
    return { identity: v.identity, confirmed: !!expected };
  }
  private confirm(user: string, a: Account) {
    this.spaces.team.db
      .prepare(
        "INSERT INTO space_github_accounts VALUES(?,?) ON CONFLICT(userId) DO UPDATE SET value=excluded.value",
      )
      .run(user, JSON.stringify(a));
    for (const j of this.jobs())
      if (j.userId === user && j.state === "waiting-account") {
        j.state = "queued";
        this.save(j);
      }
    this.kick();
  }
  async connect(user: string, projectId: string, repository: string, expected?: GitHubIdentity) {
    const c = await this.context(user, projectId, repository);
    const v = (await this.probe(c.machine, c.root, {
      op: "observe",
      repository,
      query: { kind: "identity" },
    })) as GitHubWorkObservation;
    if (!v?.identity?.id || (await this.context(user, projectId, repository)).binding !== c.binding)
      throw changed();
    if (expected) {
      if (expected.id !== v.identity.id || expected.login !== v.identity.login) throw changed();
      const a: Account = { projectId, repository, binding: c.binding, identity: v.identity };
      this.confirm(user, a);
    }
    return { identity: v.identity, confirmed: !!expected };
  }
  view(user: string, spaceId: string) {
    const s = this.scope(user, spaceId);
    const a = this.account(user);
    const jobs = this.jobs(spaceId);
    return {
      identity: a?.identity ?? null,
      grants: s.projects.flatMap((p) =>
        Object.entries(p.grants)
          .filter(([u, access]) => access === "direct" && (p.ownerId === user || u === user))
          .map(([userId]) => {
            const j = jobs.find((j) => j.projectId === p.id && j.userId === userId);
            return {
              projectId: p.id,
              userId,
              state: j?.state ?? "not-synced",
              login: j?.account?.identity.login ?? null,
              error: j?.code
                ? j.code === "SPACE_GITHUB_CHANGED"
                  ? changed().message
                  : deliveryMessage(j.code)
                : null,
            };
          }),
      ),
    };
  }
  private async run(j: Job) {
    try {
      this.allowed(j);
      const a = this.account(j.userId);
      if (!a) {
        j.state = "waiting-account";
        this.save(j);
        return;
      }
      if (j.account && hash(j.account) !== hash(a)) throw changed();
      await this.observeAccount(j.userId, a);
      const c = await this.context(j.owner, j.copy, j.repository);
      if (j.binding && j.binding !== c.binding) throw changed();
      j.binding = c.binding;
      j.account = a;
      this.allowed(j);
      j.state = "running";
      this.save(j);
      const input = {
        kind: "invite" as const,
        login: a.identity.login,
        permission: "push" as const,
        targetId: a.identity.id,
      };
      let r = (await this.probe(c.machine, c.root, {
        op: "status",
        repository: j.repository,
        id: j.id,
      })) as GitHubWorkReceipt | null;
      if (!r)
        r = (await this.probe(c.machine, c.root, {
          op: "prepare",
          repository: j.repository,
          id: j.id,
          input,
        })) as GitHubWorkReceipt;
      if (hash(r.input) !== hash(input)) throw changed();
      j.receipt = r;
      this.save(j);
      if (r.state === "prepared") {
        this.allowed(j);
        if (
          (await this.context(j.owner, j.copy, j.repository)).binding !== j.binding ||
          hash(this.account(j.userId)) !== hash(a)
        )
          throw changed();
        await this.observeAccount(j.userId, a);
        this.allowed(j);
        if (
          (await this.context(j.owner, j.copy, j.repository)).binding !== j.binding ||
          hash(this.account(j.userId)) !== hash(a)
        )
          throw changed();
        this.allowed(j);
        j.dispatched = true;
        this.save(j);
        r = (await this.probe(c.machine, c.root, {
          op: "apply",
          repository: j.repository,
          id: j.id,
          fingerprint: r.fingerprint,
        })) as GitHubWorkReceipt;
      }
      j.receipt = r;
      j.state =
        r.state === "completed"
          ? r.result?.state === "accepted"
            ? "accepted"
            : "pending"
          : r.state === "failed"
            ? "failed"
            : "unknown";
      j.code = r.code;
      this.save(j);
    } catch (error) {
      j.state = j.dispatched ? "unknown" : "failed";
      j.code = error instanceof HubError ? error.code : "GITHUB_WORK_UNAVAILABLE";
      this.save(j);
    }
  }
  kick() {
    if (this.stopped || this.task) return;
    this.task = Promise.resolve()
      .then(async () => {
        for (const j of this.jobs())
          if (["queued", "running", "unknown"].includes(j.state) && !this.stopped) {
            if (j.acceptance) await this.accept(j.userId, j.spaceId, j.projectId).catch(() => {});
            else await this.run(j);
          }
      })
      .finally(() => {
        this.task = null;
        if (!this.stopped && this.jobs().some((j) => j.state === "queued")) this.kick();
      });
  }
  async refresh(user: string, spaceId: string, projectId: string, memberId: string) {
    const s = this.scope(user, spaceId),
      p = s.projects.find((p) => p.id === projectId);
    if (!p || (p.ownerId !== user && memberId !== user) || p.grants[memberId] !== "direct")
      throw changed();
    await this.task;
    const j = this.jobs(spaceId).find((j) => j.projectId === projectId && j.userId === memberId);
    // Legacy direct grants are synchronized only by their owner explicitly.
    if (!j || j.state === "failed" || j.state === "cancelled") {
      if (p.ownerId !== user) throw changed();
      const previous = structuredClone(s);
      delete previous.projects.find((p) => p.id === projectId)!.grants[memberId];
      this.capture(s, previous);
      await this.task;
      return this.view(user, spaceId);
    }
    if (j.state === "pending" || j.state === "accepted") {
      this.allowed(j);
      if (!j.account) throw changed();
      await this.observeAccount(memberId, j.account);
      const ownerContext = await this.context(j.owner, j.copy, j.repository);
      if (ownerContext.binding !== j.binding) throw changed();
      for (let page = 1; page <= 50; page++) {
        const v = (await this.probe(ownerContext.machine, ownerContext.root, {
          op: "observe",
          repository: j.repository,
          query: { kind: "collaborators", page },
        })) as GitHubWorkObservation;
        if (
          v.repositoryId !== j.receipt?.snapshot.repositoryId ||
          v.identity.id !== j.receipt?.snapshot.identity.id
        )
          throw changed();
        const found = v.collaborators?.find(
          (v) => v.login.toLowerCase() === j.account!.identity.login.toLowerCase(),
        );
        if (found) {
          j.state = ["push", "write", "maintain", "admin"].includes(found.permission)
            ? found.state
            : "failed";
          this.allowed(j);
          this.save(j);
          break;
        }
        if (!v.nextPage) {
          j.state = "failed";
          this.save(j);
          break;
        }
      }
    } else {
      j.state = j.state === "waiting-account" ? "queued" : j.state;
      this.save(j);
      this.kick();
      await this.task;
    }
    return this.view(user, spaceId);
  }
  async accept(user: string, spaceId: string, projectId: string) {
    this.scope(user, spaceId);
    const j = this.jobs(spaceId).find((j) => j.projectId === projectId && j.userId === user);
    if (
      !j ||
      !["pending", "unknown", "accepted"].includes(j.state) ||
      !j.account ||
      !j.receipt?.snapshot.repositoryId ||
      this.accepting.has(j.id)
    )
      throw changed();
    if (j.state === "accepted") return this.view(user, spaceId);
    this.accepting.add(j.id);
    try {
      this.allowed(j);
      if (hash(this.account(user)) !== hash(j.account)) throw changed();
      const c = await this.observeAccount(user, j.account);
      this.allowed(j);
      j.acceptance ??= { id: randomUUID(), binding: c.binding };
      if (j.acceptance.receipt?.state === "failed")
        j.acceptance = { id: randomUUID(), binding: c.binding };
      if (j.acceptance.binding !== c.binding) throw changed();
      j.state = "unknown";
      this.save(j);
      const id = j.acceptance.id,
        repository = c.root === null ? j.repository : c.repository,
        input = {
          kind: "accept-invitation" as const,
          targetRepository: j.repository,
          repositoryId: j.receipt.snapshot.repositoryId,
          identityId: j.account.identity.id,
        };
      let r = (await this.probe(c.machine, c.root, {
        op: "prepare",
        repository,
        id,
        input,
      })) as GitHubWorkReceipt;
      this.allowed(j);
      if ((await this.accountContext(user, j.account)).binding !== c.binding) throw changed();
      if (r.state !== "completed" && r.state !== "failed")
        r = (await this.probe(c.machine, c.root, {
          op: "apply",
          repository,
          id,
          fingerprint: r.fingerprint,
        })) as GitHubWorkReceipt;
      j.acceptance.receipt = r;
      j.state = r.state === "completed" ? "accepted" : r.state === "failed" ? "pending" : "unknown";
      j.code = r.code;
      this.save(j);
      return this.view(user, spaceId);
    } catch (error) {
      if (j.acceptance) {
        j.state = "unknown";
        this.save(j);
      }
      throw error;
    } finally {
      this.accepting.delete(j.id);
    }
  }
  track<T>(p: Promise<T>) {
    this.operations.add(p);
    void p.finally(() => this.operations.delete(p)).catch(() => {});
    return p;
  }
  busy() {
    return (
      !!this.task ||
      !!this.operations.size ||
      this.jobs().some((j) => j.state === "running" || j.state === "unknown")
    );
  }
  async close() {
    this.stopped = true;
    await this.task;
    await Promise.allSettled([...this.operations]);
  }
}
