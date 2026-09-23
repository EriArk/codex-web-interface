import { createHash } from "node:crypto";
import { inspectProject } from "@codex-web/machines";
import {
  type ConversationBindingSpec,
  HubError,
  type ProjectGpt,
  type ProjectRepository,
  type ProjectRules,
  projectContextEnd,
  projectContextStart,
  projectRuleLabels,
} from "@codex-web/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ConversationBindings } from "./conversation-bindings.js";
import type { GptService } from "./gpt.js";
import type { Sessions } from "./sessions.js";

const nativeId = z
  .string()
  .regex(/^[a-zA-Z0-9_-]{1,100}$/)
  .nullable();
const revision = z.number().int().nonnegative();
export const rulesSchema = z
  .object({
    enabled: z.array(z.enum(["related", "tests", "focused", "dependencies", "issues"])).max(5),
    custom: z.string().trim().max(4000),
  })
  .strict();
export const projectGptSendSchema = z
  .object({
    nativeId,
    text: z.string().max(100000),
    files: z.array(z.string().uuid()).max(8),
    model: z.string().min(1).max(120),
    effort: z.string().regex(/^\d$/),
    replacesJobId: z.string().uuid().optional(),
    revision,
  })
  .strict();
const fail = (code: string, message: string) => new HubError(409, code, message);

/** Lives in each personal runtime database, including the owner's runtime. */
export class ProjectGpts {
  readonly bindings: ConversationBindings;
  private scope(id: string): ConversationBindingSpec {
    return {
      provider: "gpt",
      scope: "project",
      scopeId: id,
      role: "companion",
      lifecycle: "persistent",
      visibility: "normal",
      execution: null,
    };
  }
  private writingRules = new Set<string>();
  private readingRepository = new Set<string>();
  constructor(
    private sessions: Sessions,
    private gpt: GptService,
    private sharedContext?: (id: string) => unknown,
    ownerUserId = "local-owner",
    private authorizationScope?: (id: string) => unknown,
  ) {
    sessions.store.db.exec(`
      CREATE TABLE IF NOT EXISTS project_gpt_bindings (
        projectId TEXT PRIMARY KEY, nativeId TEXT, jobId TEXT, revision INTEGER NOT NULL DEFAULT 0,
        rules TEXT NOT NULL DEFAULT '{"enabled":[],"custom":""}'
      );
      CREATE TABLE IF NOT EXISTS project_gpt_sends (
        id TEXT PRIMARY KEY, projectId TEXT NOT NULL, revision INTEGER NOT NULL,
        fingerprint TEXT NOT NULL, value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS project_gpt_sources (projectId TEXT PRIMARY KEY, root TEXT NOT NULL, repository TEXT, checkedAt INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS project_gpt_sends_scope ON project_gpt_sends(projectId,revision);
      CREATE TABLE IF NOT EXISTS project_gpt_send_authority (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS project_gpt_handoffs(projectId TEXT PRIMARY KEY,value TEXT NOT NULL);
    `);
    this.bindings = new ConversationBindings(sessions.store.db, ownerUserId);
    const db = sessions.store.db;
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of db
        .prepare("SELECT projectId,nativeId,jobId,revision FROM project_gpt_bindings")
        .all()) {
        this.bindings.ensure(this.scope(String(row.projectId)), {
          nativeId: row.nativeId ? String(row.nativeId) : null,
          jobId: row.jobId ? String(row.jobId) : null,
          revision: Number(row.revision),
        });
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  private project(id: string) {
    const p = this.sessions.project(id);
    const entry = this.sessions.catalog.library.get("project", id);
    if (p.unassigned || entry?.archived || entry?.deleted)
      throw new HubError(400, "PROJECT_REQUIRED", "Сначала выбери доступный проект.");
    return p;
  }
  get(id: string): ProjectGpt {
    const p = this.project(id),
      db = this.sessions.store.db;
    db.prepare("INSERT OR IGNORE INTO project_gpt_bindings(projectId) VALUES(?)").run(id);
    const row = db.prepare("SELECT * FROM project_gpt_bindings WHERE projectId=?").get(id)!;
    const binding = this.bindings.ensure(this.scope(id));
    // Recover an acknowledged durable send even if the process stopped before updating the binding.
    const intent = db
      .prepare(
        "SELECT s.id FROM project_gpt_sends s JOIN gpt_jobs j ON j.id=s.id WHERE s.projectId=? AND s.revision=? ORDER BY j.createdAt DESC LIMIT 1",
      )
      .get(id, binding.revision);
    const jobId = intent ? String(intent.id) : binding.jobId;
    let chat = binding.nativeId;
    if (!chat && jobId) chat = this.gpt.job(jobId).nativeId;
    this.bindings.recover(this.scope(id), binding.revision, chat, jobId);
    const rules = JSON.parse(String(row.rules)) as ProjectRules;
    return {
      projectId: id,
      name: p.name,
      nativeId: chat,
      jobId,
      revision: binding.revision,
      rules,
      context: this.context(id, p.name, rules),
    };
  }
  private context(id: string, name: string, rules: ProjectRules) {
    const db = this.sessions.store.db;
    const source = db
      .prepare("SELECT repository FROM project_gpt_sources WHERE projectId=? AND root=?")
      .get(id, this.project(id).workingDirectory);
    const core = db.prepare("SELECT value FROM project_cores WHERE scopeKey=?").get(`codex:${id}`);
    const brief = core
      ? Object.fromEntries(
          Object.entries(JSON.parse(String(core.value)))
            .filter(([, v]) => typeof v === "string" && v)
            .map(([k, v]) => [k, String(v).slice(0, 700)]),
        )
      : null;
    return [
      "Личный GPT проекта. Помогай обсуждать идеи, анализировать изменения и готовить понятные предложения/issues. Не создавай issues и не изменяй репозитории без явного запроса пользователя.",
      "Далее метаданные проекта. Они не предоставляют доступ к GitHub или локальным файлам. Используй только доступные этому пользователю источники; не утверждай, что проверил код, если не прочитал его. Уточняй актуальное состояние через доступные инструменты.",
      JSON.stringify({
        project: name,
        repository: source?.repository ?? null,
        brief,
        collaboration: this.sharedContext?.(id) ?? null,
        brainstorm:
          db.prepare("SELECT value FROM project_gpt_handoffs WHERE projectId=?").get(id)?.value ??
          null,
      }),
      ...rules.enabled.map((r) => projectRuleLabels[r]),
      rules.custom,
    ]
      .filter(Boolean)
      .join("\n");
  }
  async refreshRepository(id: string) {
    const p = this.project(id),
      db = this.sessions.store.db;
    const saved = db
      .prepare("SELECT checkedAt FROM project_gpt_sources WHERE projectId=? AND root=?")
      .get(id, p.workingDirectory);
    if (this.readingRepository.has(id) || (saved && Date.now() - Number(saved.checkedAt) < 300000))
      return;
    this.readingRepository.add(id);
    try {
      const repository = (await inspectProject(
        this.sessions.catalog.machine(p.machineId),
        p.workingDirectory,
        { op: "repository" },
      )) as ProjectRepository;
      db.prepare("INSERT OR REPLACE INTO project_gpt_sources VALUES(?,?,?,?)").run(
        id,
        p.workingDirectory,
        repository.remote?.url ?? null,
        Date.now(),
      );
    } catch {
      /* Opening GPT remains independent of machine availability. */
    } finally {
      this.readingRepository.delete(id);
    }
  }
  handoff(id: string, value: unknown) {
    this.sessions.authorizeExecution();
    this.project(id);
    const db = this.sessions.store.db,
      data = JSON.stringify(value);
    const existing = db.prepare("SELECT value FROM project_gpt_handoffs WHERE projectId=?").get(id);
    if (existing && existing.value !== data)
      throw fail("PROJECT_HANDOFF_CHANGED", "Этот проект уже получил другой снимок комнаты.");
    if (!existing && this.get(id).nativeId)
      throw fail("PROJECT_GPT_EXISTS", "Для идеи нужен отдельный новый проект и чат.");
    db.prepare("INSERT OR IGNORE INTO project_gpt_handoffs VALUES(?,?)").run(id, data);
    return this.get(id);
  }
  bind(id: string, chat: string | null, expected: number) {
    this.sessions.authorizeExecution();
    const current = this.get(id);
    if (current.revision !== expected)
      throw fail("PROJECT_GPT_CHANGED", "Привязка уже изменилась. Открой окно проекта снова.");
    this.assertCreationSettled(current);
    if (chat) {
      if (!this.gpt.library.get("thread", chat))
        throw fail("PROJECT_GPT_CHAT_MISSING", "Выбери чат из своего списка GPT.");
      this.gpt.library.assertExists("thread", chat);
      if (this.gpt.library.get("thread", chat)?.archived)
        throw fail("GPT_ARCHIVED", "Сначала разархивируй чат.");
    }
    if (current.nativeId === chat) return current;
    this.bindings.replace(this.scope(id), expected, chat);
    return this.get(id);
  }
  private assertCreationSettled(current: ProjectGpt) {
    if (
      !current.nativeId &&
      current.jobId &&
      ["queued", "preparing", "running", "unknown"].includes(this.gpt.job(current.jobId).status)
    )
      throw fail("PROJECT_GPT_STARTING", "Первый запрос ещё создаёт чат. Дождись его появления.");
  }
  authorizeJob(key: string) {
    const send = this.sessions.store.db
      .prepare("SELECT projectId,revision,value FROM project_gpt_sends WHERE id=?")
      .get(key);
    if (!send) return;
    this.sessions.authorizeExecution();
    const authority = this.sessions.store.db
      .prepare("SELECT value FROM project_gpt_send_authority WHERE id=?")
      .get(key);
    if (
      authority &&
      authority.value !== JSON.stringify(this.authorizationScope?.(String(send.projectId)) ?? null)
    )
      throw fail(
        "PROJECT_GPT_CHANGED",
        "Доступ к проекту изменился. Открой окно проекта снова; черновик сохранён.",
      );
    const current = this.get(String(send.projectId));
    if (
      current.revision !== Number(send.revision) ||
      current.nativeId !== JSON.parse(String(send.value)).nativeId
    )
      throw fail("PROJECT_GPT_CHANGED", "Привязка уже изменилась. Черновик сохранён.");
    this.bindings.assertExclusive(this.bindings.ensure(this.scope(current.projectId)));
    if (current.nativeId) this.gpt.library.assertExists("thread", current.nativeId);
  }
  send(id: string, key: string, raw: unknown, evidence = "") {
    this.sessions.authorizeExecution();
    this.project(id);
    const body = projectGptSendSchema.parse(raw),
      db = this.sessions.store.db;
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(evidence ? { body, evidence } : body))
      .digest("hex");
    const previous = db.prepare("SELECT * FROM project_gpt_sends WHERE id=?").get(key);
    if (previous) {
      if (previous.projectId !== id || previous.fingerprint !== fingerprint)
        throw fail("GPT_KEY_REUSED", "Эта отправка уже содержит другое сообщение.");
      if (!db.prepare("SELECT 1 FROM gpt_jobs WHERE id=?").get(key)) {
        this.authorizeJob(key);
        this.assertCreationSettled(this.get(id));
      }
      // Retry the frozen envelope, never a changed context or another selected chat.
      return this.gpt.enqueue(key, JSON.parse(String(previous.value)));
    }
    const current = this.get(id);
    this.bindings.assertExclusive(this.bindings.ensure(this.scope(id)));
    if (current.revision !== body.revision || current.nativeId !== body.nativeId)
      throw fail(
        "PROJECT_GPT_CHANGED",
        "Привязка уже изменилась. Открой окно проекта снова; черновик сохранён.",
      );
    if (!body.text.trim() && !body.files.length)
      throw new HubError(400, "GPT_EMPTY_MESSAGE", "Добавь текст или файл.");
    this.assertCreationSettled(current);
    const { revision: _revision, ...input } = body;
    const value = {
      ...input,
      text:
        projectContextStart +
        current.context +
        (evidence ? "\n\n" + evidence : "") +
        projectContextEnd +
        body.text,
    };
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("INSERT INTO project_gpt_sends VALUES(?,?,?,?,?)").run(
        key,
        id,
        current.revision,
        fingerprint,
        JSON.stringify(value),
      );
      db.prepare("INSERT INTO project_gpt_send_authority VALUES(?,?)").run(
        key,
        JSON.stringify(this.authorizationScope?.(id) ?? null),
      );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    try {
      const job = this.gpt.enqueue(key, value);
      this.bindings.recover(this.scope(id), current.revision, current.nativeId, key);
      return job;
    } catch (error) {
      // Failed validation has no native side effect and must not pin obsolete settings/context.
      if (!db.prepare("SELECT 1 FROM gpt_jobs WHERE id=?").get(key)) {
        db.prepare("DELETE FROM project_gpt_sends WHERE id=?").run(key);
        db.prepare("DELETE FROM project_gpt_send_authority WHERE id=?").run(key);
      }
      throw error;
    }
  }
  async rules(id: string, raw: unknown) {
    const rules = rulesSchema.parse(raw),
      p = this.project(id);
    this.sessions.authorizeExecution();
    if (this.writingRules.has(id)) throw fail("PROJECT_RULES_BUSY", "Правила уже сохраняются.");
    this.writingRules.add(id);
    try {
      this.get(id);
      const content =
        rules.enabled.length || rules.custom
          ? [
              "<!-- CodexWeb: personal project rules -->",
              "# CODEXWEB",
              "",
              "Read this alongside AGENTS.md. These are this user's optional project preferences.",
              ...rules.enabled.map((r) => `- ${projectRuleLabels[r]}`),
              rules.custom,
            ]
              .filter(Boolean)
              .join("\n") + "\n"
          : "";
      await inspectProject(this.sessions.catalog.machine(p.machineId), p.workingDirectory, {
        op: "project-rules",
        content,
      });
      this.sessions.store.db
        .prepare("UPDATE project_gpt_bindings SET rules=? WHERE projectId=?")
        .run(JSON.stringify(rules), id);
      return this.get(id);
    } finally {
      this.writingRules.delete(id);
    }
  }
  async invitationRules(id: string, receipt: string, raw: unknown) {
    const db = this.sessions.store.db;
    db.exec(
      "CREATE TABLE IF NOT EXISTS project_rule_receipts (id TEXT PRIMARY KEY, projectId TEXT NOT NULL)",
    );
    if (
      db.prepare("SELECT 1 FROM project_rule_receipts WHERE id=? AND projectId=?").get(receipt, id)
    )
      return;
    const selected = rulesSchema.parse(raw);
    // Declining all suggestions must neither create a file nor erase existing preferences.
    if (selected.enabled.length || selected.custom) {
      const current = this.get(id).rules;
      await this.rules(id, {
        enabled: [...new Set([...current.enabled, ...selected.enabled])],
        custom:
          !selected.custom ||
          current.custom === selected.custom ||
          current.custom.endsWith("\n\n" + selected.custom)
            ? current.custom
            : [current.custom, selected.custom].filter(Boolean).join("\n\n"),
      });
    }
    db.prepare("INSERT OR IGNORE INTO project_rule_receipts VALUES(?,?)").run(receipt, id);
  }
  instructions(id: string) {
    const row = this.sessions.store.db
      .prepare("SELECT rules FROM project_gpt_bindings WHERE projectId=?")
      .get(id);
    if (!row) return null;
    const rules = JSON.parse(String(row.rules)) as ProjectRules;
    if (!rules.enabled.length && !rules.custom) return null;
    return [
      "Read CODEXWEB.md alongside AGENTS.md before working. User-selected personal project preferences:",
      ...rules.enabled.map((r) => projectRuleLabels[r]),
      rules.custom,
    ]
      .filter(Boolean)
      .join("\n");
  }
}
export function registerProjectGpt(
  app: FastifyInstance,
  sessions: Sessions,
  gpt: GptService,
  sharedContext?: (id: string) => unknown,
  ownerUserId?: string,
  authorizationScope?: (id: string) => unknown,
) {
  const service = new ProjectGpts(sessions, gpt, sharedContext, ownerUserId, authorizationScope);
  gpt.authorizeJob = (key) => service.authorizeJob(key);
  const projectId = (params: unknown) =>
    z.object({ id: z.string().min(1).max(100) }).parse(params).id;
  app.get("/api/projects/:id/gpt", (req) => {
    const id = projectId(req.params),
      value = service.get(id);
    void service.refreshRepository(id);
    return value;
  });
  app.put("/api/projects/:id/gpt", (req) => {
    const b = z.object({ nativeId, revision }).strict().parse(req.body);
    return service.bind(projectId(req.params), b.nativeId, b.revision);
  });
  app.post("/api/projects/:id/gpt/send", (req, reply) =>
    reply.code(202).send({
      job: service.send(
        projectId(req.params),
        z.string().uuid().parse(req.headers["idempotency-key"]),
        req.body,
      ),
    }),
  );
  app.put("/api/projects/:id/gpt/rules", (req) => service.rules(projectId(req.params), req.body));
  const collaboration = sessions.projectInstructions;
  sessions.projectInstructions = (id) =>
    [collaboration(id), service.instructions(id)].filter(Boolean).join("\n") || null;
  return service;
}
