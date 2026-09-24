import { createHash, randomUUID } from "node:crypto";
import { inspectProject, runProjectGitHub } from "@codex-web/machines";
import {
  type GitHubWorkReceipt,
  HubError,
  type IssueDraft,
  type IssuePackage,
  type IssueSource,
  type ProjectRepository,
} from "@codex-web/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { GptService } from "./gpt.js";
import { gptSandboxFiles } from "./gpt-sandbox-files.js";
import type { ProjectGpts } from "./project-gpt.js";
import type { Sessions } from "./sessions.js";

const digest = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const changed = () =>
  new HubError(
    409,
    "ISSUE_DRAWER_CHANGED",
    "Подборка, проект или доступ изменились. Проверь пакет снова.",
  );
const missing = () => new HubError(404, "ISSUE_DRAWER_MISSING", "Запись недоступна.");
const sourceSchema = z
  .object({
    client: z.enum(["gpt", "codex"]),
    threadId: z.string().min(1).max(120),
    messageId: z.string().min(1).max(200),
    jobId: z.string().min(1).max(200).optional(),
    projectId: z.string().max(120).optional(),
    start: z.number().int().nonnegative().optional(),
    end: z.number().int().nonnegative().optional(),
  })
  .strict();
const editSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    title: z.string().min(1).max(200),
    body: z.string().min(1).max(16000),
    targetId: z.string().max(120),
  })
  .strict();
type Saved = IssueDraft & {
  sourceHash: string;
  operationId?: string;
  native?: GitHubWorkReceipt;
  binding?: ReturnType<IssueDrawer["scope"]>;
  hidden?: boolean;
};
export class IssueDrawer {
  private pending: Promise<unknown> | null = null;
  private closed = false;
  private version = randomUUID();
  constructor(
    readonly sessions: Sessions,
    private gpt: GptService,
    private projectGpts: ProjectGpts,
    private policy: (id: string) => unknown = () => null,
    private notify: (
      projectId: string,
      batchId: string,
      issues: { number: number; url: string }[],
    ) => void = () => {},
    private probe = runProjectGitHub,
    private inspect = inspectProject,
  ) {
    this.db.exec(`CREATE TABLE IF NOT EXISTS issue_drawer_items(id TEXT PRIMARY KEY,position INTEGER NOT NULL,state TEXT NOT NULL,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS issue_drawer_batches(id TEXT PRIMARY KEY,state TEXT NOT NULL,value TEXT NOT NULL);`);
    for (const row of this.db
      .prepare("SELECT value FROM issue_drawer_items WHERE state='running'")
      .all()) {
      const i = JSON.parse(String(row.value)) as Saved;
      i.state = "unknown";
      i.error = "Отправка прервалась. Проверь результат; повторной публикации нет.";
      this.save(i);
    }
    for (const row of this.db
      .prepare("SELECT value FROM issue_drawer_batches WHERE state IN ('preparing','running')")
      .all()) {
      const b = JSON.parse(String(row.value)) as IssuePackage;
      for (const row of this.db
        .prepare("SELECT value FROM issue_drawer_items WHERE state='prepared'")
        .all()) {
        const i = JSON.parse(String(row.value)) as Saved;
        if (i.batchId === b.id) {
          i.state = "cancelled";
          this.save(i);
        }
      }
      b.state = "settled";
      this.saveBatch(b);
    }
    // Replay only local recipient notices, never native writes, after an interrupted delivery.
    for (const row of this.db
      .prepare(
        "SELECT value FROM issue_drawer_batches WHERE state='settled' ORDER BY rowid DESC LIMIT 200",
      )
      .all()) {
      this.announce(JSON.parse(String(row.value)) as IssuePackage);
    }
  }
  private get db() {
    return this.sessions.store.db;
  }
  private async serial<T>(work: () => Promise<T>): Promise<T> {
    if (this.closed || this.pending)
      throw new HubError(409, "ISSUE_DRAWER_BUSY", "Дождись текущей операции с подборкой.");
    const p = work();
    this.pending = p;
    try {
      return await p;
    } finally {
      if (this.pending === p) this.pending = null;
    }
  }
  async close() {
    this.closed = true;
    await this.pending?.catch(() => {});
  }
  private own(id: string): Saved {
    const row = this.db.prepare("SELECT value FROM issue_drawer_items WHERE id=?").get(id);
    if (!row) throw missing();
    return JSON.parse(String(row.value));
  }
  private public(i: Saved): IssueDraft {
    const { sourceHash, operationId, native, binding, hidden, ...v } = i;
    return v;
  }
  private save(i: Saved) {
    this.version = randomUUID();
    this.db
      .prepare(
        "INSERT INTO issue_drawer_items VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET position=excluded.position,state=excluded.state,value=excluded.value",
      )
      .run(i.id, i.position, i.state, JSON.stringify(i));
  }
  private saveBatch(b: IssuePackage) {
    this.version = randomUUID();
    this.db
      .prepare(
        "INSERT INTO issue_drawer_batches VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,value=excluded.value",
      )
      .run(b.id, b.state, JSON.stringify(b));
  }
  batch(id: string): IssuePackage {
    const row = this.db.prepare("SELECT value FROM issue_drawer_batches WHERE id=?").get(id);
    if (!row) throw missing();
    return JSON.parse(String(row.value));
  }
  async waitForPublication() {
    await this.pending;
  }
  item(id: string) {
    return this.public(this.own(id));
  }
  list(since?: string) {
    if (since === this.version) return { version: this.version, unchanged: true as const };
    return {
      version: this.version,
      unchanged: false as const,
      items: this.db
        .prepare(
          "SELECT value FROM issue_drawer_items WHERE COALESCE(json_extract(value,'$.hidden'),0)=0 ORDER BY position,id LIMIT 200",
        )
        .all()
        .map((r) => this.public(JSON.parse(String(r.value)))),
      batches: this.db
        .prepare(
          "SELECT value FROM issue_drawer_batches WHERE state IN ('prepared','running','preparing') OR rowid IN (SELECT rowid FROM issue_drawer_batches ORDER BY rowid DESC LIMIT 3) ORDER BY rowid DESC LIMIT 20",
        )
        .all()
        .map((r) => JSON.parse(String(r.value)) as IssuePackage),
    };
  }
  targets() {
    return this.sessions.catalog
      .projects()
      .filter(
        (p) =>
          !p.unassigned &&
          !this.sessions.catalog.library.get("project", p.id)?.archived &&
          !this.sessions.catalog.library.get("project", p.id)?.deleted,
      )
      .map((p) => ({ id: p.id, name: p.name }));
  }
  scope(id: string) {
    this.sessions.authorizeExecution();
    const p = this.sessions.project(id),
      meta = this.sessions.catalog.library.get("project", id);
    if (p.unassigned || meta?.archived || meta?.deleted) throw changed();
    return {
      projectId: id,
      machineId: p.machineId,
      root: p.workingDirectory,
      machine: digest(this.sessions.catalog.machine(p.machineId)),
      authority: this.policy(id),
    };
  }
  private check(scope: ReturnType<IssueDrawer["scope"]>) {
    if (digest(this.scope(scope.projectId)) !== digest(scope)) throw changed();
  }
  async source(source: IssueSource) {
    return (await this.resolveSource(source)).text;
  }
  private async resolveSource(source: IssueSource) {
    if (source.client === "gpt") {
      this.gpt.library.assertExists("thread", source.threadId);
      if (source.projectId && this.projectGpts.get(source.projectId).nativeId !== source.threadId)
        throw changed();
      const snapshot = await this.gpt.historyCache.snapshot(source.threadId, 0);
      const publicMessages = snapshot.items.filter(
        (m) => m.role === "assistant" && m.phase !== "commentary" && m.complete !== false,
      );
      const canonical = publicMessages.find((m) => m.id === source.messageId);
      if (canonical && !source.jobId) return { text: canonical.text, source };
      // Fresh answers use durable send text, before private download links are rewritten.
      // Require one exact receipt-bound current-branch final message, never a text search.
      const jobId = source.jobId ?? source.messageId;
      const ids = new Set(this.gpt.receiptMessageIds(jobId, source.threadId));
      const matches = publicMessages.filter((m) => ids.has(m.id));
      const message = matches.length === 1 ? matches[0] : undefined;
      if (!message || (source.jobId && message.id !== source.messageId)) throw missing();
      const job = this.gpt.job(jobId);
      if (
        job.status !== "completed" ||
        job.nativeId !== source.threadId ||
        gptSandboxFiles(job.answer, source.threadId, message.id).text !== message.text
      )
        throw changed();
      return { text: job.answer, source: { ...source, messageId: message.id, jobId } };
    }
    const t = this.sessions.thread(source.threadId);
    if (source.projectId && t.projectId !== source.projectId) throw changed();
    const m = this.db
      .prepare("SELECT text,phase FROM messages WHERE threadId=? AND id=? AND role='assistant'")
      .get(t.id, source.messageId);
    if (
      !m ||
      !["final_answer", "plan", "final"].includes(String(m.phase)) ||
      ["starting", "running", "unknown", "waiting_approval"].includes(t.status)
    )
      throw missing();
    return { text: String(m.text), source };
  }
  async add(id: string, raw: unknown) {
    return this.serial(async () => {
      const body = z
        .object({
          source: sourceSchema,
          text: z.string().min(1).max(16000),
          targetId: z.string().max(120).default(""),
        })
        .strict()
        .parse(raw);
      const prior = this.db.prepare("SELECT value FROM issue_drawer_items WHERE id=?").get(id);
      if (prior) {
        const p = JSON.parse(String(prior.value)) as Saved;
        if (p.sourceHash !== digest(body)) throw changed();
        if (p.hidden)
          throw new HubError(409, "ISSUE_DRAWER_REMOVED", "Эта запись уже убрана из подборки.");
        return this.public(p);
      }
      if (
        this.list().items!.length >= 200 ||
        Number(this.db.prepare("SELECT count(*) n FROM issue_drawer_items").get()?.n) >= 5000 ||
        Number(
          this.db
            .prepare(
              "SELECT COALESCE(sum(length(value)),0) n FROM issue_drawer_items WHERE COALESCE(json_extract(value,'$.hidden'),0)=0",
            )
            .get()?.n,
        ) >
          2 * 1024 * 1024
      )
        throw new HubError(
          409,
          "ISSUE_DRAWER_FULL",
          "В подборке уже 200 записей. Удали ненужные завершённые записи.",
        );
      const resolved = await this.resolveSource(body.source),
        text = resolved.text,
        start = body.source.start ?? 0,
        end = body.source.end ?? text.length;
      if (start > end || end > text.length || text.slice(start, end) !== body.text) throw changed();
      if (body.targetId) this.scope(body.targetId);
      const i: Saved = {
        id,
        revision: 1,
        position: Number(
          this.db.prepare("SELECT COALESCE(MAX(position),0)+1 n FROM issue_drawer_items").get()!.n,
        ),
        addedAt: Date.now(),
        source: resolved.source,
        sourceHash: digest(body),
        original: body.text,
        title:
          body.text
            .split(/\r?\n/)
            .find((s) => s.trim())
            ?.replace(/^#+\s*/, "")
            .slice(0, 200) ?? "Issue",
        body: body.text,
        targetId: body.targetId,
        state: "draft",
      };
      this.save(i);
      return this.public(i);
    });
  }
  edit(id: string, raw: unknown) {
    const body = editSchema.parse(raw),
      i = this.own(id);
    if (
      !i.hidden &&
      i.state === "draft" &&
      i.revision === body.revision + 1 &&
      i.title === body.title &&
      i.body === body.body &&
      i.targetId === body.targetId
    )
      return this.public(i);
    if (
      i.hidden ||
      i.revision !== body.revision ||
      !["draft", "failed", "cancelled"].includes(i.state) ||
      i.native?.state === "unknown" ||
      i.native?.state === "running"
    )
      throw changed();
    if (body.targetId) this.scope(body.targetId);
    if (this.pending) throw changed();
    Object.assign(i, {
      title: body.title,
      body: body.body,
      targetId: body.targetId,
      revision: i.revision + 1,
      state: "draft",
      batchId: undefined,
      operationId: undefined,
      native: undefined,
      binding: undefined,
      error: undefined,
    });
    this.save(i);
    return this.public(i);
  }
  remove(id: string, revision: number) {
    const i = this.own(id);
    if (
      this.pending ||
      i.revision !== revision ||
      ["prepared", "running", "unknown"].includes(i.state)
    )
      throw changed();
    i.hidden = true;
    this.save(i);
    return { removed: true };
  }
  reorder(ids: string[]) {
    if (this.pending) throw changed();
    const all = this.list().items!;
    if (
      ids.length !== all.length ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !all.some((i) => i.id === id))
    )
      throw changed();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      ids.forEach((id, index) => {
        const i = this.own(id);
        i.position = index;
        this.save(i);
      });
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return this.list();
  }
  private async repository(scope: ReturnType<IssueDrawer["scope"]>) {
    const machine = this.sessions.catalog.machine(scope.machineId),
      r = (await this.inspect(machine, scope.root, { op: "repository" })) as ProjectRepository;
    this.check(scope);
    const match = r.remote?.url?.match(
      /^(?:https:\/\/github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/,
    );
    if (!match) throw changed();
    const repository = match[1]!;
    const a = scope.authority as { repository?: string } | null;
    if (
      a?.repository &&
      a.repository.toLowerCase() !== `https://github.com/${repository}`.toLowerCase()
    )
      throw changed();
    return { machine, repository };
  }
  private accept(i: Saved, r: GitHubWorkReceipt | null) {
    if (
      !r ||
      r.id !== i.operationId ||
      r.input.kind !== "issue-create" ||
      r.input.title !== i.title ||
      r.input.body !== i.body ||
      (i.native &&
        (r.fingerprint !== i.native.fingerprint ||
          r.snapshot.identity.id !== i.native.snapshot.identity.id ||
          r.snapshot.repository.toLowerCase() !== i.native.snapshot.repository.toLowerCase() ||
          r.snapshot.repositoryId !== i.native.snapshot.repositoryId))
    ) {
      i.state = "unknown";
      i.error = "Нет точного подтверждения. Повторная публикация заблокирована.";
    } else {
      i.native = r;
      i.state = r.state === "running" ? "unknown" : r.state;
      i.error = r.code ? "GitHub не завершил действие. Проверь результат." : undefined;
      if (r.state === "completed") {
        const expected = `https://github.com/${r.snapshot.repository}/issues/${r.result?.number}`;
        if (!r.result?.number || r.result.url !== expected || !r.snapshot.repositoryId) {
          i.state = "unknown";
          i.error = "Нет точной квитанции публикации.";
        } else
          i.result = {
            number: r.result.number,
            url: r.result.url,
            repositoryId: r.snapshot.repositoryId,
          };
      }
    }
    this.save(i);
  }
  async prepare(id: string, raw: unknown) {
    return this.serial(async () => {
      const refs = z
        .array(z.object({ id: z.string().uuid(), revision: z.number().int().positive() }).strict())
        .min(1)
        .max(20)
        .parse(raw);
      const existing = this.db.prepare("SELECT value FROM issue_drawer_batches WHERE id=?").get(id);
      if (existing) {
        const b = JSON.parse(String(existing.value)) as IssuePackage;
        if (b.fingerprint !== digest(refs)) throw changed();
        return b;
      }
      if (
        this.db
          .prepare(
            "SELECT 1 FROM issue_drawer_batches WHERE state IN ('preparing','prepared','running')",
          )
          .get()
      )
        throw changed();
      if (Number(this.db.prepare("SELECT count(*) n FROM issue_drawer_batches").get()!.n) >= 5000)
        throw new HubError(
          409,
          "ISSUE_PACKAGES_FULL",
          "Достигнут предел сохранённых квитанций публикации.",
        );
      if (new Set(refs.map((r) => r.id)).size !== refs.length) throw changed();
      const items = refs.map((r) => {
        const i = this.own(r.id);
        if (
          i.hidden ||
          i.revision !== r.revision ||
          i.state !== "draft" ||
          !i.targetId ||
          !i.title.trim() ||
          !i.body.trim()
        )
          throw changed();
        this.scope(i.targetId);
        return i;
      });
      const b: IssuePackage = {
        id,
        fingerprint: digest(refs),
        state: "preparing",
        items: [],
        createdAt: Date.now(),
      };
      this.saveBatch(b);
      const binding = this.projectGpts.bindings.ensure({
        provider: "codex",
        scope: "operation",
        scopeId: id,
        role: "dispatcher",
        lifecycle: "job",
        visibility: "hidden",
        execution: null,
      });
      this.projectGpts.bindings.recover(binding, binding.revision, null, id);
      for (const i of items) {
        i.batchId = id;
        i.operationId = randomUUID();
        i.state = "prepared";
        this.save(i);
        try {
          i.binding = this.scope(i.targetId);
          this.save(i);
          const ctx = await this.repository(i.binding);
          this.check(i.binding);
          const r = (await this.probe(ctx.machine, i.binding.root, {
            op: "prepare",
            repository: ctx.repository,
            id: i.operationId!,
            input: { kind: "issue-create", title: i.title, body: i.body },
          })) as GitHubWorkReceipt;
          this.check(i.binding);
          if (
            r?.snapshot.repository.toLowerCase() !== ctx.repository.toLowerCase() ||
            !r.snapshot.repositoryId
          )
            throw changed();
          this.accept(i, r);
          if ((i as Saved).state === "unknown" && !i.native) throw changed();
          if (i.state !== "prepared") continue;
          b.items.push({
            id: i.id,
            revision: i.revision,
            title: i.title,
            body: i.body,
            projectId: i.targetId,
            projectName: this.sessions.project(i.targetId).name,
            repository: r.snapshot.repository,
            repositoryId: r.snapshot.repositoryId,
            identity: r.snapshot.identity,
          });
          this.saveBatch(b);
        } catch {
          i.state = "failed";
          i.error = "Не удалось проверить цель. Публикация не отправлялась.";
          this.save(i);
        }
      }
      b.state = b.items.length ? "prepared" : "settled";
      this.saveBatch(b);
      return b;
    });
  }
  confirm(id: string, fingerprint: string) {
    const b = this.batch(id);
    if (b.fingerprint !== fingerprint) throw changed();
    if (b.state !== "prepared") return b;
    if (this.pending || this.closed) throw changed();
    for (const r of b.items) {
      const i = this.own(r.id);
      if (i.batchId !== id || i.revision !== r.revision || i.state !== "prepared" || !i.binding)
        throw changed();
      this.check(i.binding);
    }
    b.state = "running";
    this.saveBatch(b);
    // Durable acknowledgement precedes the background worker. It never resumes writes after restart.
    const pending = Promise.resolve()
      .then(() => this.dispatch(b))
      .finally(() => {
        if (this.pending === pending) this.pending = null;
      });
    this.pending = pending;
    void pending.catch(() => {});
    return b;
  }
  private async dispatch(b: IssuePackage) {
    for (const r of b.items) {
      const i = this.own(r.id);
      if (i.state !== "prepared") continue;
      try {
        if (!i.binding || !i.native || !i.operationId) throw changed();
        this.check(i.binding);
        const ctx = await this.repository(i.binding);
        if (ctx.repository.toLowerCase() !== r.repository.toLowerCase()) throw changed();
        this.check(i.binding);
        i.state = "running";
        this.save(i);
        const receipt = (await this.probe(ctx.machine, i.binding.root, {
          op: "apply",
          repository: r.repository,
          id: i.operationId,
          fingerprint: i.native.fingerprint,
        })) as GitHubWorkReceipt | null;
        this.accept(i, receipt);
        if ((i as Saved).state === "prepared") {
          i.state = "unknown";
          i.error = "Публикация пока не подтверждена. Проверь исход.";
          this.save(i);
        }
      } catch {
        if (i.state !== "prepared") {
          i.state = "unknown";
          i.error = "Ответ потерян. Проверь исход; повторной отправки нет.";
        } else {
          i.state = "failed";
          i.error = "Доступ или цель изменились до публикации.";
        }
        this.save(i);
      }
    }
    b.state = "settled";
    this.saveBatch(b);
    this.announce(b);
  }
  private announce(b: IssuePackage) {
    for (const projectId of new Set(b.items.map((i) => i.projectId))) {
      const items = b.items
        .filter((r) => r.projectId === projectId)
        .map((r) => this.own(r.id))
        .filter((i) => i.batchId === b.id && i.state === "completed" && i.result);
      if (!items.length) continue;
      try {
        this.check(items[0]!.binding!);
        this.notify(
          projectId,
          b.id,
          items.map((i) => i.result!),
        );
      } catch {
        /* Private receipts remain available after revocation. */
      }
    }
  }
  async reconcile(id: string) {
    return this.serial(async () => {
      const i = this.own(id);
      if (i.state !== "unknown") return this.public(i);
      if (!i.binding || !i.operationId || !i.native) throw changed();
      this.check(i.binding);
      const ctx = await this.repository(i.binding);
      if (ctx.repository.toLowerCase() !== i.native.snapshot.repository.toLowerCase())
        throw changed();
      const r = (await this.probe(ctx.machine, i.binding.root, {
        op: "status",
        repository: ctx.repository,
        id: i.operationId,
      })) as GitHubWorkReceipt | null;
      this.accept(i, r);
      if ((i as Saved).state === "prepared") {
        i.state = "cancelled";
        this.save(i);
      }
      if (i.batchId) this.announce(this.batch(i.batchId));
      return this.public(i);
    });
  }
  cancel(id: string) {
    if (this.pending) throw changed();
    const b = this.batch(id);
    if (b.state === "cancelled") return b;
    if (!["prepared", "settled"].includes(b.state)) throw changed();
    for (const r of b.items) {
      const i = this.own(r.id);
      if (i.batchId === b.id && i.state === "prepared") {
        i.state = "cancelled";
        this.save(i);
      }
    }
    b.state = "cancelled";
    this.saveBatch(b);
    return b;
  }
}
export function registerIssueDrawer(app: FastifyInstance, service: IssueDrawer) {
  const id = (v: unknown) => z.object({ id: z.string().uuid() }).parse(v).id;
  app.get("/api/issue-drawer", (r) =>
    service.list(z.object({ since: z.string().max(100).optional() }).parse(r.query).since),
  );
  app.get("/api/issue-drawer/targets", () => service.targets());
  app.put("/api/issue-drawer/items/:id", (r) => service.add(id(r.params), r.body));
  app.patch("/api/issue-drawer/items/:id", (r) => service.edit(id(r.params), r.body));
  app.delete("/api/issue-drawer/items/:id", (r) =>
    service.remove(
      id(r.params),
      z.object({ revision: z.number().int(), confirm: z.literal(true) }).parse(r.body).revision,
    ),
  );
  app.get("/api/issue-drawer/items/:id/source", async (r) => ({
    text: await service.source(
      service.list().items!.find((i) => i.id === id(r.params))?.source ??
        (() => {
          throw missing();
        })(),
    ),
  }));
  app.post("/api/issue-drawer/order", (r) =>
    service.reorder(z.object({ ids: z.array(z.string().uuid()).max(200) }).parse(r.body).ids),
  );
  app.put("/api/issue-drawer/packages/:id", (r) =>
    service.prepare(id(r.params), z.object({ items: z.unknown() }).strict().parse(r.body).items),
  );
  app.post("/api/issue-drawer/packages/:id/confirm", async (r, reply) => {
    const b = z
      .object({ fingerprint: z.string(), confirm: z.literal(true) })
      .strict()
      .parse(r.body);
    return reply.code(202).send(service.confirm(id(r.params), b.fingerprint));
  });
  app.post("/api/issue-drawer/packages/:id/cancel", (r) => service.cancel(id(r.params)));
  app.post("/api/issue-drawer/items/:id/reconcile", (r) => service.reconcile(id(r.params)));
}
