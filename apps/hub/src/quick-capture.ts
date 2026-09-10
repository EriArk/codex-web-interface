import { createHash } from "node:crypto";
import {
  HubError,
  type QuickCaptureInput,
  type QuickCaptureReceipt,
  quickCaptureSchema,
} from "@codex-web/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Notebook } from "./notebook.js";
import type { Sessions } from "./sessions.js";
import { WorkspaceTasks } from "./tasks.js";
export class QuickCaptures {
  constructor(readonly sessions: Sessions) {}
  private get db() {
    return this.sessions.store.db;
  }
  save(id: string, input: QuickCaptureInput): QuickCaptureReceipt {
    const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const old = this.db
        .prepare("SELECT fingerprint,value FROM workspace_capture_receipts WHERE id=?")
        .get(id);
      if (old) {
        if (old.fingerprint !== fingerprint)
          throw new HubError(
            409,
            "CAPTURE_CONFLICT",
            "Эта запись уже сохранена с другим содержимым. Открой её в списке.",
          );
        const value: QuickCaptureReceipt = JSON.parse(String(old.value)),
          table = value.kind === "task" ? "workspace_tasks" : "workspace_notes";
        value.availability = this.db.prepare(`SELECT 1 FROM ${table} WHERE id=?`).get(id)
          ? "available"
          : "missing";
        this.db.exec("COMMIT");
        return value;
      }
      // One global identity across both destinations; a retry must not switch storage.
      if (
        this.db
          .prepare(
            "SELECT 1 FROM workspace_notes WHERE id=? UNION ALL SELECT 1 FROM workspace_tasks WHERE id=?",
          )
          .get(id, id)
      )
        throw new HubError(
          409,
          "CAPTURE_ID_USED",
          "Эта запись уже существует. Открой её в списке.",
        );
      const body = {
        scope: input.scope,
        title:
          input.title ||
          input.text
            .split(/\r?\n/)
            .find((s) => s.trim())!
            .trim()
            .slice(0, 120),
        body: input.text,
        revision: 0,
        links: [],
      };
      const item =
        input.kind === "task"
          ? new WorkspaceTasks(this.sessions).save(id, {
              ...body,
              status: "todo",
              priority: input.priority,
              dueAt: input.dueAt,
            })
          : new Notebook(this.sessions).save(id, body);
      const value: QuickCaptureReceipt = {
        id,
        kind: input.kind,
        title: item.title,
        scope: item.scope,
        revision: item.revision,
        availability: "available",
      };
      this.db
        .prepare("INSERT INTO workspace_capture_receipts VALUES(?,?,?,?)")
        .run(id, fingerprint, JSON.stringify(value), Date.now());
      this.db.exec("COMMIT");
      return value;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
}
export function registerQuickCapture(app: FastifyInstance, sessions: Sessions) {
  const captures = new QuickCaptures(sessions),
    id = z.object({ id: z.string().uuid() });
  app.put("/api/workspace/captures/:id", (req) =>
    captures.save(id.parse(req.params).id, quickCaptureSchema.parse(req.body)),
  );
}
