import { createHash } from "node:crypto";
import { HubError } from "@codex-web/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Sessions } from "./sessions.js";
import type { Store } from "./store.js";

type Input = Record<string, unknown>[];
type Submission = { id: string; clientUserMessageId: string; input: Input };
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const digest = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
export class QueueService {
  private locks = new Set<string>();
  constructor(
    private sessions: Sessions,
    private store: Store,
  ) {
    store.db
      .prepare(
        "UPDATE queue_transfers SET state=CASE WHEN state='enqueue_pending' THEN 'enqueue_unknown' ELSE 'unknown' END WHERE state IN ('pending','enqueue_pending')",
      )
      .run();
  }
  private async locked<T>(id: string, fn: () => Promise<T>): Promise<T> {
    if (this.locks.has(id)) throw new HubError(409, "QUEUE_BUSY", "Дождись обновления очереди");
    this.locks.add(id);
    try {
      return await this.sessions.withThreadWrite(id, fn);
    } finally {
      this.locks.delete(id);
    }
  }
  private changed(id: string) {
    this.sessions.emit("event", this.store.append(id, "queue.changed", {}));
  }
  private async native(id: string): Promise<Submission[]> {
    const t = this.sessions.thread(id),
      rpc = await this.sessions.queueClient(id);
    const response = await rpc.request("thread/queue/list", {
      threadId: t.codexThreadId,
      limit: 100,
    });
    if (!Array.isArray(response.data))
      throw new HubError(
        501,
        "CODEX_METHOD_UNSUPPORTED",
        "Этот Codex не предоставляет очередь сообщений",
      );
    if (response.nextCursor)
      throw new HubError(
        409,
        "QUEUE_LIMIT",
        "Слишком много сообщений в очереди. Открой очередь в Codex",
      );
    return response.data.map((v) => {
      const q = obj(v);
      if (
        typeof q.id !== "string" ||
        typeof q.clientUserMessageId !== "string" ||
        !Array.isArray(q.input)
      )
        throw new HubError(502, "INVALID_QUEUE_RESPONSE", "Codex вернул непонятный формат очереди");
      return { id: q.id, clientUserMessageId: q.clientUserMessageId, input: q.input as Input };
    });
  }
  private held(id: string, qid: string) {
    const row = this.store.db
      .prepare("SELECT value,state FROM queue_transfers WHERE threadId=? AND id=?")
      .get(id, qid);
    return row
      ? { submission: JSON.parse(String(row.value)) as Submission, state: String(row.state) }
      : undefined;
  }
  private public(id: string, q: Submission, state = "queued") {
    const content = q.input.filter((v) => v.type === "text").map((v) => String(v.text ?? ""));
    const files = this.store.db
      .prepare("SELECT * FROM attachments WHERE threadId=? AND messageId=?")
      .all(id, q.clientUserMessageId)
      .map((v) => this.store.attachmentPublic(v));
    return {
      id: q.id,
      text: content[0] ?? "",
      revision: digest(q),
      state,
      attachments: files,
      otherInputs: Math.max(
        0,
        q.input.length - 1 - files.filter((f) => f.image).length - (files.length ? 1 : 0),
      ),
    };
  }
  async list(id: string) {
    try {
      const native = await this.native(id);
      this.store.db
        .prepare(
          "DELETE FROM queue_transfers WHERE threadId=? AND state='steered' AND EXISTS (SELECT 1 FROM messages WHERE messages.threadId=queue_transfers.threadId AND messages.id=json_extract(queue_transfers.value, '$.clientUserMessageId'))",
        )
        .run(id);
      for (const q of native)
        this.store.db
          .prepare(
            "DELETE FROM queue_transfers WHERE threadId=? AND id=? AND state='enqueue_unknown'",
          )
          .run(id, q.clientUserMessageId);
      const held = this.store.db
        .prepare("SELECT value,state FROM queue_transfers WHERE threadId=?")
        .all(id);
      return {
        available: true,
        items: [
          ...native
            .filter(
              (q) => !held.some((v) => (JSON.parse(String(v.value)) as Submission).id === q.id),
            )
            .map((q) => this.public(id, q)),
          ...held.map((v) => this.public(id, JSON.parse(String(v.value)), String(v.state))),
        ],
        canSteer: await this.sessions.owns(id),
      };
    } catch (error) {
      if (error instanceof HubError && error.code === "CODEX_METHOD_UNSUPPORTED")
        return { available: false, items: [], canSteer: false, message: error.message };
      throw error;
    }
  }
  async add(id: string, text: string, attachmentIds: string[], clientId: string) {
    return this.locked(id, async () => {
      const t = this.sessions.thread(id),
        rpc = await this.sessions.queueClient(id);
      const queue = await this.native(id);
      const existing = queue.find((q) => q.clientUserMessageId === clientId);
      if (existing) return this.public(id, existing);
      if (queue.length >= 50) throw new HubError(409, "QUEUE_LIMIT", "В очереди уже 50 сообщений");
      const settings =
        this.store.threadSettings(id) ?? (await this.sessions.capabilities(t.projectId)).defaults;
      const model = (await this.sessions.capabilities(t.projectId)).models.find(
        (m) => m.id === settings.model,
      );
      const prepared = await this.sessions.attachments.prepare(
        { ...this.sessions.config, projects: this.sessions.catalog.projects() },
        id,
        attachmentIds,
        model?.supportsImages ?? false,
      );
      const pending: Submission = {
        id: clientId,
        clientUserMessageId: clientId,
        input: [{ type: "text", text }, ...prepared.input],
      };
      try {
        this.sessions.assertWritable(t.projectId);
        this.sessions.attachments.bind(id, clientId, prepared.files);
        this.store.db
          .prepare("INSERT INTO queue_transfers VALUES(?,?,?,'enqueue_pending')")
          .run(id, clientId, JSON.stringify(pending));
        const response = await rpc.request("thread/queue/add", {
          threadId: t.codexThreadId,
          clientUserMessageId: clientId,
          input: pending.input,
        });
        const q = obj(response.queuedSubmission) as unknown as Submission;
        if (!q.id || q.clientUserMessageId !== clientId || !Array.isArray(q.input))
          throw new HubError(502, "INVALID_QUEUE_RESPONSE", "Очередь не подтвердила сообщение");
        this.store.db
          .prepare("DELETE FROM queue_transfers WHERE threadId=? AND id=?")
          .run(id, clientId);
        this.changed(id);
        return this.public(id, q);
      } catch (error) {
        this.store.db
          .prepare("UPDATE queue_transfers SET state='enqueue_unknown' WHERE threadId=? AND id=?")
          .run(id, clientId);
        this.changed(id);
        throw error;
      } finally {
        prepared.release();
      }
    });
  }
  async change(
    id: string,
    qid: string,
    revision: string,
    action: "edit" | "delete" | "steer" | "restore",
    text?: string,
    expectedTurnId?: string,
  ) {
    return this.locked(id, async () => {
      const t = this.sessions.thread(id),
        rpc = await this.sessions.queueClient(id);
      const held = this.held(id, qid);
      if (held?.state === "steered")
        throw new HubError(409, "MESSAGE_ACCEPTED", "Codex уже принял сообщение.");
      if (held && ["pending", "enqueue_pending"].includes(held.state))
        throw new HubError(409, "QUEUE_BUSY", "Steer ещё передаётся");
      const q = held?.submission ?? (await this.native(id)).find((v) => v.id === qid);
      if (!q)
        throw new HubError(
          409,
          "QUEUE_CHANGED",
          "Сообщение уже отправлено или удалено. Очередь обновлена",
        );
      if (digest(q) !== revision)
        throw new HubError(
          409,
          "QUEUE_CHANGED",
          "Сообщение изменилось на другом устройстве. Проверь новую версию",
        );
      if (action === "edit") {
        const input = q.input.map((v) => ({ ...v }));
        const first = input.findIndex((v) => v.type === "text");
        if (first < 0) input.unshift({ type: "text", text });
        else input[first] = { ...input[first], text };
        if (held)
          this.store.db
            .prepare("UPDATE queue_transfers SET value=? WHERE threadId=? AND id=?")
            .run(JSON.stringify({ ...q, input }), id, qid);
        else
          await rpc.request("thread/queue/update", {
            threadId: t.codexThreadId,
            queuedSubmissionId: qid,
            input,
          });
      } else if (action === "delete") {
        if (held)
          this.store.db
            .prepare("DELETE FROM queue_transfers WHERE threadId=? AND id=?")
            .run(id, qid);
        else {
          const result = await rpc.request("thread/queue/delete", {
            threadId: t.codexThreadId,
            queuedSubmissionId: qid,
          });
          if (result.deleted !== true)
            throw new HubError(409, "QUEUE_CHANGED", "Сообщение уже начало выполняться");
        }
      } else if (action === "restore") {
        if (!held) throw new HubError(409, "QUEUE_CHANGED", "Сообщение уже в очереди");
        await rpc.request("thread/queue/add", {
          threadId: t.codexThreadId,
          clientUserMessageId: q.clientUserMessageId,
          input: q.input,
        });
        this.store.db.prepare("DELETE FROM queue_transfers WHERE threadId=? AND id=?").run(id, qid);
      } else {
        // Never attempt to steer a different process or a turn that finished while the UI was open.
        if (!(await this.sessions.owns(id)))
          throw new HubError(
            409,
            "THREAD_IN_USE",
            "Steer доступен для работы, запущенной через сайт. Очередь сохранена в Codex",
          );
        if (held || !expectedTurnId || this.store.thread(id).activeTurnId !== expectedTurnId)
          throw new HubError(
            409,
            "TURN_CHANGED",
            "Текущий ход изменился. Сообщение осталось в очереди",
          );
        this.store.db
          .prepare("INSERT INTO queue_transfers VALUES(?,?,?,'pending')")
          .run(id, qid, JSON.stringify(q));
        try {
          const deleted = await rpc.request("thread/queue/delete", {
            threadId: t.codexThreadId,
            queuedSubmissionId: qid,
          });
          if (deleted.deleted !== true) {
            this.store.db
              .prepare("DELETE FROM queue_transfers WHERE threadId=? AND id=?")
              .run(id, qid);
            throw new HubError(409, "QUEUE_CHANGED", "Сообщение уже начало выполняться");
          }
          const steered = await rpc.request("turn/steer", {
            threadId: t.codexThreadId,
            expectedTurnId,
            input: q.input,
            clientUserMessageId: q.clientUserMessageId,
          });
          if (steered.turnId !== expectedTurnId)
            throw new HubError(
              502,
              "INVALID_STEER_RESPONSE",
              "Codex не подтвердил направление текущего хода",
            );
          // Keep accepted Steer visible until Codex emits the matching user message.
          this.store.db
            .prepare("UPDATE queue_transfers SET state='steered' WHERE threadId=? AND id=?")
            .run(id, qid);
        } catch (error) {
          this.store.db
            .prepare("UPDATE queue_transfers SET state='unknown' WHERE threadId=? AND id=?")
            .run(id, qid);
          this.changed(id);
          throw error;
        }
      }
      this.changed(id);
      return { ok: true };
    });
  }
}
export function registerQueue(app: FastifyInstance, sessions: Sessions, store: Store) {
  const service = new QueueService(sessions, store);
  const params = (v: unknown) =>
    z
      .object({ id: z.string().min(1).max(100), qid: z.string().min(1).max(100).optional() })
      .parse(v);
  app.get("/api/threads/:id/queue", async (req) => service.list(params(req.params).id));
  app.post("/api/threads/:id/queue", async (req) => {
    const { id } = params(req.params),
      body = z
        .object({
          text: z.string().trim().max(32000),
          attachments: z.array(z.string().uuid()).max(8).default([]),
          clientId: z.string().uuid(),
        })
        .strict()
        .refine((v) => v.text.length || v.attachments.length)
        .parse(req.body);
    return store.once("queue:" + id, body.clientId, body, () =>
      service.add(id, body.text, body.attachments, body.clientId),
    );
  });
  app.post("/api/threads/:id/queue/:qid", async (req) => {
    const { id, qid } = params(req.params),
      body = z
        .object({
          revision: z.string().length(64),
          action: z.enum(["edit", "delete", "steer", "restore"]),
          text: z.string().max(32000).optional(),
          expectedTurnId: z.string().min(1).max(100).optional(),
        })
        .strict()
        .refine((v) => v.action !== "edit" || !!v.text?.trim())
        .parse(req.body);
    const key = z.string().uuid().parse(req.headers["idempotency-key"]);
    return store.once("queue-action:" + id + ":" + qid, key, body, () =>
      service.change(id, qid!, body.revision, body.action, body.text, body.expectedTurnId),
    );
  });
  return service;
}
