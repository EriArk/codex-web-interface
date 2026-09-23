import { createHash } from "node:crypto";
import { inspectProject } from "@codex-web/machines";
import {
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
  private writingRules = new Set<string>();
  private readingRepository = new Set<string>();
  constructor(
    private sessions: Sessions,
    private gpt: GptService,
    private sharedContext?: (id: string) => unknown,
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
    `);
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
    // Recover an acknowledged durable send even if the process stopped before updating the binding.
    const intent = db
      .prepare(
        "SELECT s.id FROM project_gpt_sends s JOIN gpt_jobs j ON j.id=s.id WHERE s.projectId=? AND s.revision=? ORDER BY j.createdAt DESC LIMIT 1",
      )
      .get(id, Number(row.revision));
    const jobId = intent ? String(intent.id) : row.jobId ? String(row.jobId) : null;
    let chat = row.nativeId ? String(row.nativeId) : null;
    if (!chat && jobId) chat = this.gpt.job(jobId).nativeId;
    if (chat !== row.nativeId || jobId !== row.jobId)
      db.prepare("UPDATE project_gpt_bindings SET nativeId=?,jobId=? WHERE projectId=?").run(
        chat,
        jobId,
        id,
      );
    const rules = JSON.parse(String(row.rules)) as ProjectRules;
    return {
      projectId: id,
      name: p.name,
      nativeId: chat,
      jobId,
      revision: Number(row.revision),
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
  bind(id: string, chat: string | null, expected: number) {
    const current = this.get(id);
    if (current.revision !== expected)
      throw fail("PROJECT_GPT_CHANGED", "Привязка уже изменилась. Открой окно проекта снова.");
    if (chat) {
      if (!this.gpt.library.get("thread", chat))
        throw fail("PROJECT_GPT_CHAT_MISSING", "Выбери чат из своего списка GPT.");
      this.gpt.library.assertExists("thread", chat);
      if (this.gpt.library.get("thread", chat)?.archived)
        throw fail("GPT_ARCHIVED", "Сначала разархивируй чат.");
    }
    this.sessions.store.db
      .prepare(
        "UPDATE project_gpt_bindings SET nativeId=?,jobId=NULL,revision=revision+1 WHERE projectId=?",
      )
      .run(chat, id);
    return this.get(id);
  }
  send(id: string, key: string, raw: unknown, evidence = "") {
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
      if (
        !db.prepare("SELECT 1 FROM gpt_jobs WHERE id=?").get(key) &&
        this.get(id).revision !== body.revision
      )
        throw fail(
          "PROJECT_GPT_CHANGED",
          "Привязка уже изменилась. Открой окно проекта снова; черновик сохранён.",
        );
      // Retry the frozen envelope, never a changed context or another selected chat.
      return this.gpt.enqueue(key, JSON.parse(String(previous.value)));
    }
    const current = this.get(id);
    if (current.revision !== body.revision || current.nativeId !== body.nativeId)
      throw fail(
        "PROJECT_GPT_CHANGED",
        "Привязка уже изменилась. Открой окно проекта снова; черновик сохранён.",
      );
    if (!body.text.trim() && !body.files.length)
      throw new HubError(400, "GPT_EMPTY_MESSAGE", "Добавь текст или файл.");
    if (
      !current.nativeId &&
      current.jobId &&
      ["queued", "preparing", "running", "unknown"].includes(this.gpt.job(current.jobId).status)
    )
      throw fail("PROJECT_GPT_STARTING", "Первый запрос ещё создаёт чат. Дождись его появления.");
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
    db.prepare("INSERT INTO project_gpt_sends VALUES(?,?,?,?,?)").run(
      key,
      id,
      current.revision,
      fingerprint,
      JSON.stringify(value),
    );
    try {
      const job = this.gpt.enqueue(key, value);
      db.prepare("UPDATE project_gpt_bindings SET jobId=? WHERE projectId=?").run(key, id);
      return job;
    } catch (error) {
      // Failed validation has no native side effect and must not pin obsolete settings/context.
      if (!db.prepare("SELECT 1 FROM gpt_jobs WHERE id=?").get(key))
        db.prepare("DELETE FROM project_gpt_sends WHERE id=?").run(key);
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
) {
  const service = new ProjectGpts(sessions, gpt, sharedContext);
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
