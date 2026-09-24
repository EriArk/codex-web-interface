import { createHash, randomUUID } from "node:crypto";
import { runProjectGitHub } from "@codex-web/machines";
import {
  type GitHubWorkObservation,
  type GitHubWorkProbeRequest,
  type GitHubWorkProbeResult,
  type GitHubWorkQuery,
  type GitHubWorkReceipt,
  githubWorkQuerySchema,
  HubError,
  type MachineConfig,
  type SharedMaterialWrite,
  type TeamCheckout,
  type TeamGitHubLink,
  type TeamGitHubOperation,
  type TeamGitHubPrepare,
  type TeamGitHubSource,
  teamGitHubPrepareSchema,
} from "@codex-web/shared";
import type { createApp } from "./app.js";
import { bridgeId, type TeamBridges } from "./team-bridges.js";
import type { TeamProjects } from "./team-projects.js";

type Personal = (userId: string) => Promise<{ runtime: Awaited<ReturnType<typeof createApp>> }>;
export type GitHubProbe = (
  machine: MachineConfig,
  root: string | null,
  request: GitHubWorkProbeRequest,
) => Promise<GitHubWorkProbeResult>;
type Binding = {
  checkout: TeamCheckout;
  machine: MachineConfig;
  root: string;
  repository: string;
  epoch: number;
  membership: number;
};
type Operation = TeamGitHubOperation & {
  request: TeamGitHubPrepare;
  binding: Binding;
  inputHash: string;
  sourceSnapshot?: { title: string; text: string };
};
type Observation = {
  id: string;
  cacheKey: string;
  projectId: string;
  userId: string;
  bindingHash: string;
  value: GitHubWorkObservation;
};
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const missing = () => new HubError(404, "TEAM_GITHUB_MISSING", "GitHub-запись недоступна.");
const changed = () =>
  new HubError(
    409,
    "TEAM_GITHUB_CHANGED",
    "Проект, доступ или рабочая папка изменились. Проверь действие заново.",
  );

/** GitHub credentials stay on the acting member's execution machine. No owner-account fallback. */
export class TeamGitHub {
  private pending = new Map<string, Promise<unknown>>();
  private waiting = new Map<string, number>();
  private closed = false;
  constructor(
    readonly projects: TeamProjects,
    private rooms: TeamBridges,
    private personal: Personal,
    private authorize: () => void,
    private probe: GitHubProbe = runProjectGitHub,
  ) {
    for (const row of this.db
      .prepare("SELECT value FROM team_github_operations WHERE state IN ('running','preparing')")
      .all()) {
      const v = JSON.parse(String(row.value)) as Operation;
      v.state = v.state === "running" ? "unknown" : "failed";
      v.error =
        v.state === "unknown"
          ? "После перезапуска проверь исход. Запрос не отправляется повторно."
          : "Подготовка прервалась до подтверждения. Можно подготовить действие снова.";
      this.save(v);
    }
  }
  get db() {
    return this.projects.db;
  }
  busy() {
    return this.pending.size > 0;
  }
  async close() {
    this.closed = true;
    await Promise.allSettled([...this.pending.values()]);
  }
  private async serial<T>(key: string, work: () => Promise<T>): Promise<T> {
    if (
      this.closed ||
      (this.waiting.get(key) ?? 0) >= 3 ||
      (this.pending.size >= 12 && !this.pending.has(key))
    )
      throw new HubError(
        429,
        "TEAM_GITHUB_BUSY",
        "GitHub уже обрабатывает запросы. Повтори после завершения.",
      );
    this.waiting.set(key, (this.waiting.get(key) ?? 0) + 1);
    const task = Promise.resolve(this.pending.get(key))
      .catch(() => {})
      .then(() => {
        if (this.closed) throw changed();
        return work();
      });
    this.pending.set(key, task);
    try {
      return await task;
    } finally {
      this.waiting.set(key, (this.waiting.get(key) ?? 1) - 1);
      if (this.pending.get(key) === task) {
        this.pending.delete(key);
        this.waiting.delete(key);
      }
    }
  }
  private async context(actor: string, projectId: string, write = false): Promise<Binding> {
    this.authorize();
    const project = this.projects.access(actor, projectId, write ? "write" : "read"),
      checkout = this.projects.checkout(actor, projectId);
    if (!project.repository || !checkout)
      throw new HubError(
        409,
        "TEAM_GITHUB_CHECKOUT",
        "Подключи свою рабочую папку этого репозитория.",
      );
    const { runtime } = await this.personal(actor);
    const native = runtime.sessions.project(checkout.personalProjectId),
      machine = runtime.sessions.catalog.machine(native.machineId);
    if (native.machineId !== checkout.machineId) throw changed();
    const user = this.projects.registry.active(actor),
      member = this.db
        .prepare(
          "SELECT revision FROM team_project_members WHERE projectId=? AND userId=? AND state='active'",
        )
        .get(projectId, actor);
    if (!member) throw missing();
    const latest = this.projects.access(actor, projectId, write ? "write" : "read");
    if (
      latest.repository !== project.repository ||
      hash(this.projects.checkout(actor, projectId)) !== hash(checkout)
    )
      throw changed();
    return {
      checkout,
      machine,
      root: native.workingDirectory,
      repository: project.repository.replace("https://github.com/", ""),
      epoch: user.executionEpoch,
      membership: Number(member.revision),
    };
  }
  private equal(a: Binding, b: Binding) {
    return hash(a) === hash(b);
  }
  private own(actor: string, projectId: string, id: string): Operation {
    this.projects.access(actor, projectId);
    const row = this.db
      .prepare("SELECT value FROM team_github_operations WHERE id=? AND projectId=? AND userId=?")
      .get(id, projectId, actor);
    if (!row) throw missing();
    return JSON.parse(String(row.value));
  }
  private public(v: Operation): TeamGitHubOperation {
    const { request, binding, inputHash, sourceSnapshot, ...result } = v;
    return result;
  }
  get(actor: string, projectId: string, id: string) {
    return this.public(this.own(actor, projectId, id));
  }
  async discard(actor: string, projectId: string, id: string) {
    return this.serial("write:" + actor, async () => {
      const v = this.own(actor, projectId, id);
      if (v.state !== "prepared" && v.state !== "failed") throw changed();
      v.state = "failed";
      v.error = "Подготовка отменена. Действие не отправлено в GitHub.";
      this.save(v);
      return this.public(v);
    });
  }
  private save(v: Operation) {
    v.updatedAt = Date.now();
    this.db
      .prepare(
        "INSERT INTO team_github_operations VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,value=excluded.value,updatedAt=excluded.updatedAt",
      )
      .run(v.id, v.projectId, v.userId, v.state, JSON.stringify(v), v.updatedAt);
  }
  private result(v: Operation, receipt: GitHubWorkReceipt | null) {
    if (
      !receipt ||
      receipt.id !== v.id ||
      hash(receipt.input) !== hash(v.request.input) ||
      receipt.snapshot.repository.toLowerCase() !== v.binding.repository.toLowerCase() ||
      (v.native &&
        (receipt.fingerprint !== v.native.fingerprint ||
          receipt.snapshot.identity.id !== v.native.snapshot.identity.id))
    ) {
      v.state = "unknown";
      v.error = "Компьютер не подтвердил сохранённое действие. Повторной отправки нет.";
    } else {
      v.native = receipt;
      v.state = receipt.state;
      v.error = receipt.code ? githubProblem(receipt.code) : undefined;
    }
    this.save(v);
    return this.public(v);
  }
  page(actor: string, projectId: string, offset = 0) {
    this.projects.access(actor, projectId);
    const rows = this.db
      .prepare(
        "SELECT value FROM team_github_links WHERE projectId=? ORDER BY updatedAt DESC,id LIMIT 21 OFFSET ?",
      )
      .all(projectId, offset);
    return {
      items: rows.slice(0, 20).map((r) => JSON.parse(String(r.value)) as TeamGitHubLink),
      nextOffset: rows.length > 20 ? offset + 20 : null,
      accounts: this.db
        .prepare(
          "SELECT a.value,u.name,u.id FROM team_github_accounts a JOIN team_users u ON u.id=a.userId WHERE a.projectId=?",
        )
        .all(projectId)
        .map((r) => ({
          identity: JSON.parse(String(r.value)).identity,
          checkedAt: JSON.parse(String(r.value)).checkedAt,
          userId: String(r.id),
          name: String(r.name),
        })),
      operations: this.db
        .prepare(
          "SELECT value FROM team_github_operations WHERE projectId=? AND userId=? ORDER BY updatedAt DESC LIMIT 20",
        )
        .all(projectId, actor)
        .map((r) => this.public(JSON.parse(String(r.value)))),
    };
  }
  observation(actor: string, projectId: string, id: string): Observation {
    this.projects.access(actor, projectId);
    const row = this.db
      .prepare("SELECT value FROM team_github_observations WHERE id=? AND projectId=? AND userId=?")
      .get(id, projectId, actor);
    if (!row) throw missing();
    return JSON.parse(String(row.value));
  }
  async observe(actor: string, projectId: string, raw: GitHubWorkQuery) {
    const query = githubWorkQuerySchema.parse(raw),
      cacheId = hash([actor, projectId, query]);
    return this.serial("read:" + actor, async () => {
      const ctx = await this.context(actor, projectId),
        bindingHash = hash(ctx),
        row = this.db
          .prepare(
            "SELECT value FROM team_github_observations WHERE projectId=? AND userId=? AND json_extract(value,'$.cacheKey')=? ORDER BY updatedAt DESC LIMIT 1",
          )
          .get(projectId, actor, cacheId);
      if (row) {
        const old = JSON.parse(String(row.value)) as Observation;
        if (old.bindingHash === bindingHash && Date.now() - old.value.checkedAt < 10000) return old;
      }
      const value = (await this.probe(ctx.machine, ctx.root, {
        op: "observe",
        repository: ctx.repository,
        query,
      })) as GitHubWorkObservation;
      if (!this.equal(ctx, await this.context(actor, projectId))) throw changed();
      if (
        !value ||
        value.repository.toLowerCase() !== ctx.repository.toLowerCase() ||
        !value.identity?.login ||
        hash(value.query) !== hash(query)
      )
        throw changed();
      const saved: Observation = {
        id: hash([cacheId, bindingHash, value]),
        cacheKey: cacheId,
        projectId,
        userId: actor,
        bindingHash,
        value,
      };
      this.db
        .prepare(
          "INSERT INTO team_github_observations VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value,updatedAt=excluded.updatedAt",
        )
        .run(saved.id, projectId, actor, JSON.stringify(saved), Date.now());
      this.db
        .prepare(
          "DELETE FROM team_github_observations WHERE projectId=? AND userId=? AND id NOT IN(SELECT id FROM team_github_observations WHERE projectId=? AND userId=? ORDER BY updatedAt DESC LIMIT 100)",
        )
        .run(projectId, actor, projectId, actor);
      return saved;
    });
  }
  async confirmIdentity(actor: string, projectId: string, id: string, key: string) {
    const saved = this.observation(actor, projectId, id),
      ctx = await this.context(actor, projectId);
    if (saved.bindingHash !== hash(ctx) || Date.now() - saved.value.checkedAt > 300000)
      throw changed();
    return this.projects.once(
      actor,
      "github.identity:" + projectId,
      key,
      { id, identity: saved.value.identity },
      () => {
        this.db
          .prepare(
            "INSERT INTO team_github_accounts VALUES(?,?,?) ON CONFLICT(projectId,userId) DO UPDATE SET value=excluded.value",
          )
          .run(
            projectId,
            actor,
            JSON.stringify({
              identity: saved.value.identity,
              checkedAt: saved.value.checkedAt,
              checkoutId: ctx.checkout.id,
            }),
          );
        this.projects.changed(actor, projectId, "github.identity_confirmed");
        return { confirmed: true };
      },
    );
  }
  source(actor: string, projectId: string, source: TeamGitHubSource) {
    this.projects.access(actor, projectId);
    if (source.kind === "material") {
      const v = this.projects.get(actor, projectId, source.id),
        c = v.content;
      const text =
        c.kind === "plan"
          ? c.description +
            "\n\n" +
            c.sections
              .map((s) => "## " + s.title + "\n" + s.items.map((i) => "- " + i.text).join("\n"))
              .join("\n\n")
          : "body" in c
            ? c.body
            : JSON.stringify(c.value, null, 2);
      return { title: v.title, text: text.slice(0, 16000), truncated: text.length > 16000 };
    }
    const d = this.rooms.access(actor, source.id);
    if (
      d.bridge.projectId !== projectId &&
      !d.bridge.participants.some(
        (p) => p.projectId === projectId && p.userId === actor && p.state === "accepted",
      )
    )
      throw missing();
    let text = d.bridge.goal + "\n\nГотово, когда:\n" + d.bridge.criteria;
    if (source.entryId) {
      const row = this.db
        .prepare("SELECT value FROM team_bridge_entries WHERE id=? AND bridgeId=?")
        .get(source.entryId, source.id);
      if (!row) throw missing();
      text = JSON.parse(String(row.value)).text;
    }
    return { title: d.bridge.title, text: text.slice(0, 16000), truncated: text.length > 16000 };
  }
  private target(actor: string, projectId: string, request: TeamGitHubPrepare) {
    if (request.input.kind === "accept-invitation" || request.input.kind.startsWith("preparation-"))
      throw changed();
    if (!["invite", "remove", "request-review"].includes(request.input.kind)) return;
    this.projects.access(
      actor,
      projectId,
      request.input.kind === "request-review" ? "write" : "owner",
    );
    if (!request.memberId || request.memberId === actor) throw changed();
    const member = this.db
      .prepare("SELECT state FROM team_project_members WHERE projectId=? AND userId=?")
      .get(projectId, request.memberId);
    if (!member || (request.input.kind !== "remove" && member.state !== "active")) throw missing();
  }
  async prepare(actor: string, projectId: string, id: string, raw: unknown) {
    const request = teamGitHubPrepareSchema.parse(raw),
      inputHash = hash(request);
    return this.serial("write:" + actor, async () => {
      this.projects.access(actor, projectId, "write");
      this.target(actor, projectId, request);
      const prior = this.db.prepare("SELECT 1 FROM team_github_operations WHERE id=?").get(id);
      if (prior) {
        const old = this.own(actor, projectId, id);
        if (old.inputHash !== inputHash) throw changed();
        return this.public(old);
      }
      if (
        this.db
          .prepare(
            "SELECT 1 FROM team_github_operations WHERE projectId=? AND userId=? AND state IN ('preparing','running','unknown')",
          )
          .get(projectId, actor)
      )
        throw new HubError(
          409,
          "TEAM_GITHUB_PENDING",
          "Сначала проверь исход предыдущего GitHub-действия.",
        );
      if (
        Number(
          this.db
            .prepare("SELECT COUNT(*) n FROM team_github_operations WHERE projectId=?")
            .get(projectId)?.n,
        ) >= 5000
      )
        throw new HubError(
          409,
          "TEAM_GITHUB_CAPACITY",
          "Достигнут предел сохранённых GitHub-действий проекта.",
        );
      const binding = await this.context(actor, projectId, true),
        sourceSnapshot = request.source ? this.source(actor, projectId, request.source) : undefined;
      const v: Operation = {
        id,
        projectId,
        userId: actor,
        userName: this.projects.registry.user(actor).name,
        request,
        inputHash,
        binding,
        source: request.source,
        sourceSnapshot,
        memberId: request.memberId,
        machineName: binding.machine.name,
        state: "preparing",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      this.save(v);
      try {
        const result = (await this.probe(binding.machine, binding.root, {
          op: "prepare",
          repository: binding.repository,
          id,
          input: request.input,
        })) as GitHubWorkReceipt;
        if (!this.equal(binding, await this.context(actor, projectId, true))) throw changed();
        this.target(actor, projectId, request);
        return this.result(v, result);
      } catch (error) {
        v.state = "failed";
        v.error = githubProblem(error);
        this.save(v);
        throw error;
      }
    });
  }
  async confirm(actor: string, projectId: string, id: string) {
    return this.serial("write:" + actor, async () => {
      const v = this.own(actor, projectId, id);
      this.projects.access(actor, projectId, "write");
      this.target(actor, projectId, v.request);
      if (v.state !== "prepared") return this.public(v);
      const current = await this.context(actor, projectId, true);
      if (!this.equal(v.binding, current) || !v.native) throw changed();
      if (v.source) this.source(actor, projectId, v.source);
      v.state = "running";
      this.save(v);
      this.authorize();
      try {
        const result = (await this.probe(current.machine, current.root, {
          op: "apply",
          repository: current.repository,
          id,
          fingerprint: v.native.fingerprint,
        })) as GitHubWorkReceipt | null;
        this.result(v, result);
        // Keep exact receipts even if permission was revoked during the external request.
        this.projects.access(actor, projectId, "write");
        if (!this.equal(current, await this.context(actor, projectId, true))) throw changed();
        this.projects.changed(actor, projectId, "github." + v.state, id);
        return this.public(v);
      } catch (error) {
        if (v.state === "running") {
          v.state = "unknown";
          v.error = githubProblem(error);
          this.save(v);
        }
        throw error;
      }
    });
  }
  async status(actor: string, projectId: string, id: string) {
    return this.serial("write:" + actor, async () => {
      const v = this.own(actor, projectId, id);
      if (["completed", "failed", "prepared"].includes(v.state)) return this.public(v);
      const ctx = await this.context(actor, projectId);
      if (
        ctx.checkout.id !== v.binding.checkout.id ||
        ctx.root !== v.binding.root ||
        hash(ctx.machine) !== hash(v.binding.machine) ||
        ctx.repository !== v.binding.repository
      )
        throw changed();
      const result = (await this.probe(ctx.machine, ctx.root, {
        op: "status",
        repository: ctx.repository,
        id,
      })) as GitHubWorkReceipt | null;
      this.result(v, result);
      this.projects.access(actor, projectId);
      return this.public(v);
    });
  }
  link(
    actor: string,
    projectId: string,
    key: string,
    input: { observationId: string; source?: TeamGitHubSource },
  ) {
    this.projects.access(actor, projectId, "write");
    const o = this.observation(actor, projectId, input.observationId),
      record = o.value.record;
    if (!record) throw changed();
    if (input.source) this.source(actor, projectId, input.source);
    const id = bridgeId(projectId, hash([record.url, input.source ?? null]));
    return this.projects.once(actor, "github.link:" + projectId, key, input, () => {
      const old = this.db.prepare("SELECT value FROM team_github_links WHERE id=?").get(id);
      if (old && JSON.parse(String(old.value)).checkedAt > o.value.checkedAt) throw changed();
      const v: TeamGitHubLink = {
        id,
        fingerprint: hash([id, record, o.value.checkedAt]),
        projectId,
        record,
        source: input.source,
        userId: actor,
        userName: this.projects.registry.user(actor).name,
        checkedAt: o.value.checkedAt,
      };
      this.db
        .prepare(
          "INSERT INTO team_github_links VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value,updatedAt=excluded.updatedAt",
        )
        .run(id, projectId, JSON.stringify(v), Date.now());
      this.projects.changed(actor, projectId, "github.linked", id);
      return v;
    });
  }
  work(actor: string, projectId: string, id: string, key: string, expectedFingerprint: string) {
    this.projects.access(actor, projectId, "write");
    if (!this.projects.checkout(actor, projectId)) throw changed();
    const row = this.db
      .prepare("SELECT value FROM team_github_links WHERE id=? AND projectId=?")
      .get(id, projectId);
    if (!row) throw missing();
    const link = JSON.parse(String(row.value)) as TeamGitHubLink,
      record = link.record,
      planId = bridgeId(id, hash([actor, record]));
    const prepared = this.projects.once(
      actor,
      "github.work:" + projectId,
      key,
      { id, expectedFingerprint },
      () => {
        if (link.fingerprint !== expectedFingerprint) throw changed();
        const body: SharedMaterialWrite = {
          revision: 0,
          assigneeId: actor,
          content: {
            kind: "plan",
            title:
              `${record.type === "pr" ? "PR" : "Issue"} #${record.number} · ${record.title}`.slice(
                0,
                120,
              ),
            description: `${record.url}\nАвтор: ${record.author.login}; состояние: ${record.state}; проверено: ${new Date(link.checkedAt).toISOString()}\n${record.head ? "Ветка: " + record.head.branch + "\nТочный SHA: " + record.head.sha + "\n" : ""}\n${record.body.slice(0, 4800)}${record.body.length > 4800 ? "\n[Текст сокращён; полный материал доступен в GitHub.]" : ""}`,
            status: "draft",
            sections: [
              {
                id: randomUUID(),
                title: "Работа по GitHub",
                items: [
                  {
                    id: randomUUID(),
                    text:
                      "Проверить актуальное состояние и выполнить согласованную работу по " +
                      record.url,
                    checked: false,
                  },
                ],
              },
            ],
          },
        };
        return { planId, body };
      },
    );
    // Reserve the exact snapshot first; material writes own their transaction and retry receipt.
    if (this.db.prepare("SELECT 1 FROM team_materials WHERE id=?").get(prepared.planId))
      return this.projects.get(actor, projectId, prepared.planId);
    return this.projects.put(actor, projectId, prepared.planId, key, prepared.body);
  }
}
export function githubProblem(error: unknown) {
  if (error instanceof HubError) return error.message;
  return typeof error === "string" && error === "GITHUB_WORK_IDENTITY_CHANGED"
    ? "GitHub-аккаунт изменился. Подготовь действие заново."
    : typeof error === "string" && error === "GITHUB_WORK_CHANGED"
      ? "Issue или PR изменился. Проверь новую версию."
      : typeof error === "string" && error === "GITHUB_WORK_REJECTED"
        ? "GitHub отклонил действие. Проверь доступ и состояние."
        : "GitHub не подтвердил действие. Проверь его состояние; автоматического повтора нет.";
}
