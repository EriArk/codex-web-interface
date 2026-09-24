import { createHash, randomUUID } from "node:crypto";
import { inspectProject } from "@codex-web/machines";
import {
  type AgentProfileSnapshot,
  HubError,
  type ProjectRules,
  type ProjectRulesFile,
  renderProjectRules,
} from "@codex-web/shared";
import type { Sessions } from "./sessions.js";

const hash = (v: string) => createHash("sha256").update(v).digest("hex");
type Document = {
  revision: number;
  content: string;
  binding: string;
  pending?: { rules: ProjectRules; content: string; expected: string | null; key: string };
};
export class ProjectProfiles {
  private busy = new Set<string>();
  constructor(
    private sessions: Sessions,
    private rules: (id: string) => ProjectRules,
    private authority: (id: string) => unknown,
    private probe = inspectProject,
  ) {
    sessions.store.db.exec(
      "CREATE TABLE IF NOT EXISTS project_rule_documents(projectId TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
  }
  private binding(id: string) {
    const p = this.sessions.project(id);
    const entry = this.sessions.catalog.library.get("project", id);
    if (p.unassigned || entry?.archived || entry?.deleted)
      throw new HubError(409, "PROJECT_REQUIRED", "Выбери доступный проект.");
    return hash(
      JSON.stringify({
        project: { id: p.id, machineId: p.machineId, workingDirectory: p.workingDirectory },
        machine: this.sessions.catalog.machine(p.machineId),
        authority: this.authority(id),
      }),
    );
  }
  private get(id: string): Document {
    const row = this.sessions.store.db
      .prepare("SELECT value FROM project_rule_documents WHERE projectId=?")
      .get(id);
    return row
      ? JSON.parse(String(row.value))
      : { revision: 0, content: renderProjectRules(this.rules(id)), binding: this.binding(id) };
  }
  private put(id: string, value: Document) {
    this.sessions.store.db
      .prepare("INSERT OR REPLACE INTO project_rule_documents VALUES(?,?)")
      .run(id, JSON.stringify(value));
  }
  private async read(id: string, key?: string) {
    const p = this.sessions.project(id);
    return (await this.probe(this.sessions.catalog.machine(p.machineId), p.workingDirectory, {
      op: "project-rules-read",
      ...(key ? { key } : {}),
    })) as ProjectRulesFile;
  }
  private commit(id: string, document: Document) {
    const pending = document.pending!;
    const db = this.sessions.store.db;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("UPDATE project_gpt_bindings SET rules=? WHERE projectId=?").run(
        JSON.stringify(pending.rules),
        id,
      );
      this.put(id, {
        revision: document.revision + 1,
        content: pending.content,
        binding: document.binding,
      });
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  async snapshot(id: string): Promise<AgentProfileSnapshot> {
    const binding = this.binding(id);
    let document = this.get(id);
    const file = await this.read(id, document.pending?.key);
    if (binding !== this.binding(id) || (document.pending && document.binding !== binding))
      throw new HubError(
        409,
        "PROFILE_BINDING_CHANGED",
        "Привязка проекта изменилась. Сначала проверь незавершённое сохранение в прежней рабочей копии.",
      );
    if (
      document.pending?.key !== this.get(id).pending?.key ||
      document.revision !== this.get(id).revision
    )
      throw new HubError(409, "PROFILE_CHANGED", "Профиль изменился. Обнови просмотр.");
    if (
      document.pending &&
      !this.busy.has(id) &&
      file.receipt === "failed" &&
      file.content !== document.pending.content
    ) {
      this.sessions.authorizeExecution();
      this.put(id, { ...document, revision: document.revision + 1, pending: undefined });
      document = this.get(id);
    }
    // Read-only reconciliation proves desired bytes; never dispatches a write again.
    if (
      document.pending &&
      !this.busy.has(id) &&
      file.editable &&
      file.content === document.pending.content
    ) {
      this.sessions.authorizeExecution();
      this.commit(id, document);
      document = this.get(id);
    }
    const matches = file.content === document.content;
    return {
      projectId: id,
      revision: document.revision,
      rules: this.rules(id),
      pending: !!document.pending,
      binding,
      savedContent: document.content,
      file: {
        ...file,
        editable: file.editable && matches && !document.pending,
        ...(!matches
          ? {
              reason:
                "CODEXWEB.md изменён вручную. Сравни версии и восстанови сохранённый текст перед применением профиля.",
            }
          : {}),
      },
    };
  }
  async cancel(id: string, expected: { revision: number; binding: string }) {
    this.sessions.authorizeExecution();
    const document = this.get(id),
      binding = this.binding(id);
    if (
      expected.binding !== binding ||
      expected.revision !== document.revision ||
      document.binding !== binding
    )
      throw new HubError(409, "PROFILE_CHANGED", "Профиль изменился. Обнови сравнение.");
    if (!document.pending) return;
    if (this.busy.has(id)) throw new HubError(409, "PROFILE_BUSY", "Сохранение ещё выполняется.");
    const release = this.sessions.beginProjectDelivery(id);
    this.busy.add(id);
    try {
      const p = this.sessions.project(id),
        intent = document.pending;
      const file = (await this.probe(
        this.sessions.catalog.machine(p.machineId),
        p.workingDirectory,
        {
          op: "project-rules-cancel",
          key: intent.key,
          expected: intent.expected,
          content: intent.content,
        },
      )) as ProjectRulesFile;
      this.sessions.authorizeExecution();
      if (binding !== this.binding(id))
        throw new HubError(409, "PROFILE_BINDING_CHANGED", "Привязка проекта изменилась.");
      if (!["complete", "failed"].includes(file.receipt ?? ""))
        throw new HubError(409, "PROFILE_PENDING", "Сохранение ещё не завершилось.");
      if (file.editable && file.content === intent.content) this.commit(id, document);
      else this.put(id, { ...document, revision: document.revision + 1, pending: undefined });
    } finally {
      this.busy.delete(id);
      release();
    }
  }
  async save(
    id: string,
    rules: ProjectRules,
    expected?: { revision: number; fingerprint: string | null; binding: string },
  ) {
    this.sessions.authorizeExecution();
    if (this.busy.has(id)) throw new HubError(409, "PROFILE_BUSY", "Профиль уже сохраняется.");
    const initial = await this.snapshot(id);
    if (this.busy.has(id)) throw new HubError(409, "PROFILE_BUSY", "Профиль уже сохраняется.");
    if (
      expected &&
      (initial.binding !== expected.binding ||
        initial.revision !== expected.revision ||
        initial.file.fingerprint !== expected.fingerprint)
    )
      throw new HubError(
        409,
        "PROFILE_CHANGED",
        "Профиль изменился. Обнови сравнение; черновик сохранён.",
      );
    if (!initial.file.editable || initial.pending)
      throw new HubError(
        409,
        "PROFILE_FILE_CONFLICT",
        initial.file.reason ?? "Результат предыдущего сохранения ещё не подтверждён.",
      );
    const content = renderProjectRules(rules);
    if (JSON.stringify(initial.rules) === JSON.stringify(rules)) return;
    const release = this.sessions.beginProjectDelivery(id);
    this.busy.add(id);
    try {
      const document = this.get(id),
        binding = this.binding(id);
      if (document.revision !== initial.revision || document.pending || initial.binding !== binding)
        throw new HubError(409, "PROFILE_CHANGED", "Профиль изменился. Обнови сравнение.");
      this.sessions.authorizeExecution();
      const intent: Document = {
        ...document,
        binding,
        pending: { rules, content, expected: initial.file.fingerprint, key: randomUUID() },
      };
      this.put(id, intent);
      const p = this.sessions.project(id);
      const result = (await this.probe(
        this.sessions.catalog.machine(p.machineId),
        p.workingDirectory,
        {
          op: "project-rules",
          content,
          expected: initial.file.fingerprint,
          key: intent.pending!.key,
        },
      )) as ProjectRulesFile;
      this.sessions.authorizeExecution();
      if (binding !== this.binding(id))
        throw new HubError(409, "PROFILE_BINDING_CHANGED", "Доступ к проекту изменился.");
      if (!result.editable || result.content !== content) {
        // A confirmed comparison rejection had no CODEXWEB mutation.
        this.put(id, document);
        throw new HubError(409, "PROFILE_FILE_CONFLICT", result.reason ?? "Файл изменился.");
      }
      this.commit(id, intent);
    } finally {
      this.busy.delete(id);
      release();
    }
  }
}
