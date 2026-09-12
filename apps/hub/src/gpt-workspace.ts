import { createHash } from "node:crypto";
import {
  type GptCanvas,
  HubError,
  type NativeWorkspaceReceipt,
  type ScheduledTask,
} from "@codex-web/shared";
import { z } from "zod";
import type { Store } from "./store.js";
export const workspaceId = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const scheduleBase = z.object({ kind: z.literal("schedule"), id: workspaceId, revision });
export const workspaceInput = z.union([
  scheduleBase.extend({ action: z.enum(["pause", "resume"]) }).strict(),
  scheduleBase.extend({ action: z.literal("delete"), confirm: z.literal(true) }).strict(),
  scheduleBase
    .extend({
      action: z.literal("save"),
      title: z.string().trim().min(1).max(500),
      prompt: z.string().trim().min(1).max(100000),
      schedule: z.string().min(1).max(8000),
      timezone: z
        .string()
        .min(1)
        .max(120)
        .refine((v) => {
          try {
            new Intl.DateTimeFormat("en", { timeZone: v });
            return true;
          } catch {
            return false;
          }
        }),
      enabled: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("canvas"),
      action: z.literal("restore"),
      id: workspaceId,
      conversationId: workspaceId,
      revision,
      version: z.number().int().min(1).max(1000000),
      confirm: z.literal(true),
    })
    .strict(),
]);
export const scheduledSchema = z.object({
  id: workspaceId,
  title: z.string().max(500),
  prompt: z.string().max(100000),
  enabled: z.boolean(),
  schedule: z.string().max(8000),
  displaySchedule: z.string().max(1000),
  timezone: z.string().max(120),
  timing: z.string().max(80),
  nextRuns: z.array(z.string().max(100)).max(5),
  lastRun: z.string().max(100).nullable(),
  conversationId: workspaceId.nullable(),
  eventDriven: z.boolean(),
  canEdit: z.boolean(),
  canDelete: z.boolean(),
  revision,
});
export const canvasSchema = z.object({
  id: workspaceId,
  conversationId: workspaceId,
  title: z.string().max(500),
  type: z.string().max(100),
  content: z.string().max(250000),
  version: z.number().int().min(1),
  revision,
});
type Input = z.infer<typeof workspaceInput>;
type Data = {
  input: Input;
  baseline?: ScheduledTask | GptCanvas;
  expected?: GptCanvas;
  error: string;
};
type Row = { key: string; digest: string; state: string; response: string };
const scope = "gpt-workspace";
const failure = (code: string, message: string) => new HubError(409, code, message);
export class GptWorkspaceWork {
  private running: string | null = null;
  private work = Promise.resolve();
  constructor(
    private store: Store,
    private json: (path: string, body?: unknown) => Promise<unknown>,
    private canStart: () => boolean,
  ) {
    store.db
      .prepare("UPDATE commands SET state='unknown' WHERE scope=? AND state='pending'")
      .run(scope);
  }
  counts() {
    const r = this.store.db
      .prepare(
        "SELECT COALESCE(SUM(state='pending'),0) active, COALESCE(SUM(state='unknown'),0) unknown FROM commands WHERE scope=?",
      )
      .get(scope)!;
    return {
      active: Number(r.active) + (this.running && Number(r.active) === 0 ? 1 : 0),
      unknown: Number(r.unknown) - (this.running && Number(r.unknown) > 0 ? 1 : 0),
    };
  }
  blocked() {
    return (
      !!this.running ||
      !!this.store.db
        .prepare("SELECT 1 FROM commands WHERE scope=? AND state IN ('pending','unknown') LIMIT 1")
        .get(scope)
    );
  }
  private row(id: string) {
    const row = this.store.db
      .prepare("SELECT * FROM commands WHERE scope=? AND key=?")
      .get(scope, id) as Row | undefined;
    if (!row) throw new HubError(404, "GPT_WORKSPACE_RECEIPT", "Действие не найдено.");
    return row;
  }
  private view(row: Row): NativeWorkspaceReceipt {
    const data = JSON.parse(row.response) as Data;
    return {
      id: row.key,
      kind: data.input.kind,
      targetId: data.input.id,
      state:
        this.running === row.key
          ? "pending"
          : row.state === "complete"
            ? "completed"
            : (row.state as NativeWorkspaceReceipt["state"]),
      error: this.running === row.key ? "Проверяем результат…" : data.error,
    };
  }
  get(id: string) {
    return this.view(this.row(id));
  }
  list() {
    return (
      this.store.db
        .prepare(
          "SELECT * FROM commands WHERE scope=? ORDER BY CASE WHEN state IN ('pending','unknown') THEN 0 ELSE 1 END, createdAt DESC LIMIT 30",
        )
        .all(scope) as Row[]
    ).map((r) => this.view(r));
  }
  private set(id: string, state: string, data: Data) {
    this.store.db
      .prepare("UPDATE commands SET state=?,response=? WHERE scope=? AND key=?")
      .run(state, JSON.stringify(data), scope, id);
  }
  async schedules(cursor?: string) {
    return z
      .object({ items: z.array(scheduledSchema).max(200), cursor: z.string().max(4000).nullable() })
      .parse(
        await this.json("/scheduled" + (cursor ? "?cursor=" + encodeURIComponent(cursor) : "")),
      );
  }
  async schedule(id: string) {
    return z
      .object({ item: scheduledSchema.nullable() })
      .parse(await this.json("/scheduled/item?id=" + encodeURIComponent(workspaceId.parse(id))))
      .item;
  }
  async canvases(conversationId: string) {
    const result = z
      .object({ items: z.array(canvasSchema).max(100) })
      .parse(
        await this.json(
          "/canvas?conversationId=" + encodeURIComponent(workspaceId.parse(conversationId)),
        ),
      );
    if (result.items.some((v) => v.conversationId !== conversationId))
      throw failure("GPT_CANVAS_IDENTITY", "Документ относится к другому чату.");
    return result;
  }
  async version(conversationId: string, id: string, version: number) {
    workspaceId.parse(conversationId);
    workspaceId.parse(id);
    z.number().int().min(1).max(1000000).parse(version);
    const value = canvasSchema.parse(
      await this.json(
        `/canvas/version?conversationId=${encodeURIComponent(conversationId)}&id=${encodeURIComponent(id)}&version=${version}`,
      ),
    );
    if (value.conversationId !== conversationId || value.id !== id || value.version !== version)
      throw failure("GPT_CANVAS_IDENTITY", "Версия документа не подтверждена.");
    return value;
  }
  private async read(input: Input) {
    return input.kind === "schedule"
      ? this.schedule(input.id)
      : ((await this.canvases(input.conversationId)).items.find((c) => c.id === input.id) ?? null);
  }
  start(id: string, value: Input) {
    const input = workspaceInput.parse(value),
      digest = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const previous = this.store.db
      .prepare("SELECT digest FROM commands WHERE scope=? AND key=?")
      .get(scope, id);
    if (previous) {
      if (previous.digest !== digest)
        throw failure("IDEMPOTENCY_CONFLICT", "Этот запрос уже сохранён с другими данными.");
      return { id };
    }
    if (!this.canStart() || this.blocked())
      throw failure("GPT_BUSY", "Сначала заверши или проверь текущее действие GPT.");
    const data: Data = { input, error: "" };
    this.store.db
      .prepare(
        "INSERT INTO commands(scope,key,digest,state,response,createdAt) VALUES(?,?,?,'pending',?,?)",
      )
      .run(scope, id, digest, JSON.stringify(data), new Date().toISOString());
    this.running = id;
    this.work = this.run(id, data);
    return { id };
  }
  private async run(id: string, data: Data) {
    let dispatched = false;
    try {
      const active = z
        .object({ generating: z.boolean().optional(), requestId: z.unknown().optional() })
        .parse(await this.json("/active"));
      if (active.generating || active.requestId) throw failure("GPT_BUSY", "ChatGPT сейчас занят.");
      const before = await this.read(data.input);
      if (!before || before.revision !== data.input.revision)
        throw failure(
          "GPT_WORKSPACE_CHANGED",
          "Данные изменились. Обнови их перед сохранением; твой черновик сохранён.",
        );
      if (
        data.input.kind === "schedule" &&
        (!("canEdit" in before) ||
          !before.canEdit ||
          (data.input.action === "delete" && !before.canDelete))
      )
        throw failure("GPT_WORKSPACE_READONLY", "Для этой задачи нет прав изменения.");
      if (
        data.input.kind === "schedule" &&
        data.input.action === "save" &&
        "eventDriven" in before &&
        before.eventDriven
      )
        throw failure(
          "GPT_WORKSPACE_EVENT",
          "Правила событий изменяются в ChatGPT. Здесь доступны пауза и удаление.",
        );
      data.baseline = before;
      if (data.input.kind === "canvas")
        data.expected = await this.version(
          data.input.conversationId,
          data.input.id,
          data.input.version,
        );
      this.set(id, "unknown", { ...data, error: "Подтверждение ещё не получено." });
      dispatched = true;
      const result = z
        .object({ dispatched: z.boolean(), code: z.string().nullable().optional() })
        .parse(await this.json("/workspace-mutation", data.input));
      if (!result.dispatched) {
        dispatched = false;
        throw failure(
          "GPT_WORKSPACE_NOT_SENT",
          "ChatGPT не применил изменение. Обнови данные перед новой попыткой.",
        );
      }
      if (!(await this.check(id, true)))
        this.set(id, "unknown", {
          ...data,
          error: "ChatGPT пока не подтвердил изменение. Проверка не повторяет действие.",
        });
    } catch (error) {
      this.set(id, dispatched ? "unknown" : "failed", {
        ...data,
        error: dispatched
          ? "Соединение прервалось. Проверь результат; действие не отправится повторно."
          : error instanceof HubError
            ? error.message
            : "Не удалось прочитать данные. Изменение не отправлено.",
      });
    } finally {
      this.running = null;
    }
  }
  async check(id: string, worker = false) {
    if (this.running === id && !worker) return false;
    const row = this.row(id);
    if (!["pending", "unknown"].includes(row.state)) return row.state === "complete";
    const data = JSON.parse(row.response) as Data;
    if (!data.baseline) {
      this.set(id, "failed", { ...data, error: "Изменение не было отправлено." });
      return false;
    }
    const now = await this.read(data.input),
      input = data.input;
    const matches =
      input.kind === "canvas"
        ? !!now &&
          "version" in now &&
          "version" in data.baseline &&
          now.version > data.baseline.version &&
          now.content === data.expected?.content
        : input.action === "delete"
          ? now === null
          : !!now &&
            "enabled" in now &&
            (input.action === "save"
              ? now.title === input.title &&
                now.prompt === input.prompt &&
                now.schedule === input.schedule &&
                now.timezone === input.timezone &&
                now.enabled === input.enabled
              : now.enabled === (input.action === "resume"));
    if (matches) this.set(id, "complete", { ...data, error: "" });
    return matches;
  }
  async checked(id: string) {
    if (this.running === id) throw failure("GPT_BUSY", "Дождись завершения проверки.");
    const row = this.row(id);
    if (row.state !== "unknown") return;
    if (await this.check(id)) return;
    const data = JSON.parse(this.row(id).response) as Data;
    await this.read(data.input);
    if (this.row(id).state === "unknown")
      this.set(id, "failed", {
        ...data,
        error: "Результат проверен вручную. Повторной отправки не было.",
      });
  }
  async close() {
    await this.work;
  }
}
