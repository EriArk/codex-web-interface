import { createHash } from "node:crypto";
import { type GptOperation, HubError } from "@codex-web/shared";
import { z } from "zod";
import { gptHistory } from "./gpt-history.js";
import { gptVersion, gptVersions, versionHash } from "./gpt-versions.js";
import type { Store } from "./store.js";

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export const gptOperationInput = z
  .object({
    nativeId: id,
    messageId: id,
    currentNode: id,
    action: z.enum(["edit", "regenerate", "fork"]),
    text: z.string().max(100000),
    targetMessageId: id.optional(),
    model: z.string().min(1).max(120),
    effort: z.string().regex(/^\d$/),
  })
  .strict();
type Input = z.infer<typeof gptOperationInput>;
type Json = Record<string, any>;
const fail = (code: string, message: string) => new HubError(409, code, message);
const fingerprint = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const path = (source: Json) => {
  const nodes: Json[] = [],
    seen = new Set<string>();
  let cursor = source.current_node;
  while (typeof cursor === "string" && !seen.has(cursor) && nodes.length < 20000) {
    seen.add(cursor);
    const node = source.mapping?.[cursor];
    if (!node) break;
    nodes.push({ ...node, nodeId: cursor });
    cursor = node.parent;
  }
  return nodes.reverse();
};
export function operationBaseline(source: Json, input: Input) {
  if (source.current_node !== input.currentNode)
    throw fail("GPT_NATIVE_CHANGED", "Ветка изменилась. Открой действие заново.");
  if (input.action === "fork") {
    if (!input.targetMessageId || !input.text.trim())
      throw fail("GPT_NATIVE_INPUT", "Выбери версию и напиши первое сообщение новой ветки.");
    const preview = gptVersion(source, input.nativeId, input.messageId, input.targetMessageId);
    return {
      ids: Object.keys(source.mapping ?? {}),
      parent: null,
      user: "",
      files: [],
      prefix: preview.hash,
      count: preview.count,
      createdAt: Date.now(),
    };
  }
  const messages = gptHistory(source, input.nativeId),
    message = messages.find((m) => m.id === input.messageId);
  if (!message || message.role !== (input.action === "edit" ? "user" : "assistant"))
    throw fail("GPT_NATIVE_SOURCE", "Сообщение больше не находится в текущей ветке.");
  if (
    input.action === "edit" &&
    (!input.text.trim() || input.text === message.text || message.unsupported?.length)
  )
    throw fail(
      "GPT_NATIVE_INPUT",
      "Измени текст сообщения. Неподдерживаемое содержимое редактируется в ChatGPT.",
    );
  const nodes = path(source),
    index = nodes.findIndex((n) => n.message?.id === input.messageId),
    node = nodes[index];
  const user = nodes
    .slice(0, index + 1)
    .reverse()
    .find((n) => n.message?.author?.role === "user");
  if (!node || !user) throw fail("GPT_NATIVE_SOURCE", "Не удалось определить исходный запрос.");
  return {
    ids: Object.keys(source.mapping ?? {}),
    parent: node.parent,
    user: user.nodeId,
    files: message.files.map((f) => f.id).sort(),
  };
}
export function operationConfirmation(
  source: Json,
  input: Input,
  baseline: ReturnType<typeof operationBaseline>,
) {
  const nodes = path(source),
    ids = new Set(baseline.ids),
    visible = gptHistory(source, input.nativeId);
  if (input.action === "fork") {
    if (
      !baseline.prefix ||
      !baseline.count ||
      versionHash(visible.slice(0, baseline.count)) !== baseline.prefix
    )
      return false;
    const next = visible.slice(baseline.count).filter((m) => m.role === "user" && !ids.has(m.id));
    if (
      next.length !== 1 ||
      next[0]!.text !== input.text ||
      next[0]!.createdAt * 1000 < (baseline.createdAt ?? 0) - 30000
    )
      return false;
    const userNode = nodes.findIndex((n) => n.message?.id === next[0]!.id);
    return nodes
      .slice(userNode + 1)
      .some(
        (n) =>
          n.message?.author?.role === "assistant" &&
          n.message?.status === "finished_successfully" &&
          (!n.message.channel || n.message.channel === "final") &&
          visible.some((m) => m.id === n.message.id),
      );
  }
  let user = baseline.user;
  if (input.action === "edit") {
    const matches = nodes.filter(
      (n) =>
        !ids.has(n.nodeId) &&
        n.parent === baseline.parent &&
        n.message?.author?.role === "user" &&
        visible.some(
          (m) =>
            m.id === n.message.id &&
            m.text === input.text &&
            JSON.stringify(m.files.map((f) => f.id).sort()) === JSON.stringify(baseline.files),
        ),
    );
    if (matches.length !== 1) return false;
    user = matches[0]!.nodeId;
  }
  const index = nodes.findIndex((n) => n.nodeId === user);
  if (index < 0) return false;
  // Only this user's response, never a later owner's turn or a hidden analysis node.
  const response = nodes.slice(index + 1);
  if (response.some((n) => n.message?.author?.role === "user")) return false;
  return response.some(
    (n) =>
      !ids.has(n.nodeId) &&
      n.message?.author?.role === "assistant" &&
      n.message?.status === "finished_successfully" &&
      (!n.message.channel || n.message.channel === "final") &&
      visible.some((m) => m.id === n.message.id),
  );
}

export class GptOperations {
  private work = Promise.resolve();
  private runningId: string | null = null;
  constructor(
    private store: Store,
    private json: (path: string, body?: unknown) => Promise<Json>,
    private canStart: () => boolean,
    private changed: (id: string) => void,
    private signal: AbortSignal,
  ) {
    store.db
      .prepare(
        "UPDATE gpt_native_operations SET state='unknown',error='Соединение прервалось. Проверь текущую ветку.' WHERE state IN ('preparing','running')",
      )
      .run();
  }
  blocked() {
    return (
      !!this.runningId ||
      !!this.store.db
        .prepare(
          "SELECT 1 FROM gpt_native_operations WHERE state IN ('preparing','running','unknown') LIMIT 1",
        )
        .get()
    );
  }
  counts() {
    const row = this.store.db
      .prepare(
        "SELECT COALESCE(SUM(state IN ('preparing','running')),0) active,COALESCE(SUM(state='unknown'),0) unknown FROM gpt_native_operations",
      )
      .get()!;
    return { active: Number(row.active), unknown: Number(row.unknown) };
  }
  list(nativeId?: string) {
    const items = this.store.db
      .prepare(
        "SELECT id,nativeId,resultNativeId,messageId,json_extract(input,'$.targetMessageId') AS targetMessageId,action,text,state,error,createdAt,updatedAt FROM gpt_native_operations WHERE (? IS NULL OR nativeId=?) ORDER BY createdAt DESC LIMIT 20",
      )
      .all(nativeId ?? null, nativeId ?? null) as GptOperation[];
    return {
      items: items.map((item) =>
        item.id === this.runningId && item.state === "unknown"
          ? { ...item, state: "running" as const }
          : item,
      ),
      blocked: this.blocked(),
    };
  }
  get(operationId: string) {
    const row = this.store.db
      .prepare("SELECT * FROM gpt_native_operations WHERE id=?")
      .get(operationId) as Json | undefined;
    if (!row) throw new HubError(404, "GPT_OPERATION_MISSING", "Действие не найдено.");
    return row;
  }
  private set(operationId: string, state: GptOperation["state"], error = "") {
    this.store.db
      .prepare("UPDATE gpt_native_operations SET state=?,error=?,updatedAt=? WHERE id=?")
      .run(state, error, Date.now(), operationId);
  }
  async preview(nativeId: string, messageId: string) {
    const source = await this.json("/conversation?id=" + encodeURIComponent(nativeId));
    const message = gptHistory(source, nativeId).find((m) => m.id === messageId);
    if (!message) throw fail("GPT_NATIVE_SOURCE", "Сообщение больше не находится в текущей ветке.");
    return { currentNode: id.parse(source.current_node), message };
  }
  async versions(nativeId: string, messageId: string, targetMessageId?: string) {
    const source = await this.json("/conversation?id=" + encodeURIComponent(nativeId));
    return targetMessageId
      ? gptVersion(source, nativeId, messageId, targetMessageId)
      : gptVersions(source, nativeId, messageId);
  }
  start(operationId: string, input: Input) {
    const print = fingerprint(input),
      existing = this.store.db
        .prepare("SELECT fingerprint FROM gpt_native_operations WHERE id=?")
        .get(operationId);
    if (existing) {
      if (existing.fingerprint !== print)
        throw fail("IDEMPOTENCY_CONFLICT", "Это действие уже сохранено с другим текстом.");
      return { id: operationId };
    }
    if (!this.canStart() || this.blocked())
      throw fail("GPT_BUSY", "Сначала заверши или проверь текущее действие GPT.");
    const now = Date.now();
    this.store.db
      .prepare(
        "INSERT INTO gpt_native_operations(id,nativeId,messageId,action,text,state,error,createdAt,updatedAt,fingerprint,input,baseline) VALUES(?,?,?,?,?,'preparing','',?,?,?,?,NULL)",
      )
      .run(
        operationId,
        input.nativeId,
        input.messageId,
        input.action,
        input.text,
        now,
        now,
        print,
        JSON.stringify(input),
      );
    this.runningId = operationId;
    this.work = this.run(operationId, input);
    return { id: operationId };
  }
  private async run(operationId: string, input: Input) {
    let dispatched = false;
    try {
      const active = await this.json("/active");
      if (active.generating || active.requestId) throw fail("GPT_BUSY", "ChatGPT сейчас занят.");
      const features = await this.json("/native-features");
      if (!features.ready || features.generating)
        throw fail("GPT_BUSY", "ChatGPT сейчас занят или недоступен.");
      const source = await this.json("/conversation?id=" + encodeURIComponent(input.nativeId)),
        baseline = operationBaseline(source, input);
      this.store.db
        .prepare("UPDATE gpt_native_operations SET baseline=? WHERE id=?")
        .run(JSON.stringify(baseline), operationId);
      await this.json("/bridge/sessions/select", { sessionId: input.nativeId });
      if (input.action === "edit") {
        const selected = await this.json("/settings", { model: input.model, effort: input.effort });
        if (selected.model !== input.model || String(selected.effort) !== input.effort)
          throw fail(
            "GPT_SETTINGS_NOT_CONFIRMED",
            "Не удалось подтвердить выбранные модель и режим. Текст сохранён.",
          );
      }
      // Persist uncertainty before entering the connector. A lost reply must never replay a click.
      this.set(operationId, "unknown", "Проверяем подтверждение ChatGPT.");
      dispatched = true;
      const result = await this.json("/native-operation", {
        ...input,
        conversationId: input.nativeId,
      });
      if (result.dispatched === false) {
        dispatched = false;
        throw fail(
          "GPT_NATIVE_UNAVAILABLE",
          "Не удалось выполнить действие в ChatGPT. Текст сохранён; открой действие заново.",
        );
      }
      if (
        input.action === "fork" &&
        id.safeParse(result.nativeId).success &&
        result.nativeId !== input.nativeId
      )
        this.store.db
          .prepare("UPDATE gpt_native_operations SET resultNativeId=? WHERE id=?")
          .run(result.nativeId, operationId);
      this.set(operationId, "running");
      const end = Date.now() + 150000;
      while (!this.signal.aborted && Date.now() < end) {
        if (await this.confirm(operationId, true)) return;
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            this.signal.removeEventListener("abort", done);
            resolve();
          };
          const timer = setTimeout(done, 1800);
          this.signal.addEventListener("abort", done, { once: true });
        });
      }
      this.set(
        operationId,
        "unknown",
        "ChatGPT не подтвердил завершение. Проверь ветку перед новым действием.",
      );
    } catch (error) {
      this.set(
        operationId,
        dispatched ? "unknown" : "failed",
        dispatched
          ? "Подтверждение потеряно. Проверка прочитает историю без повторной отправки."
          : error instanceof HubError
            ? error.message
            : "Действие не отправлено. Текст сохранён.",
      );
    } finally {
      this.runningId = null;
      this.changed(input.nativeId);
    }
  }
  async confirm(operationId: string, worker = false) {
    if (this.runningId === operationId && !worker) return false;
    const row = this.get(operationId);
    if (row.state === "completed") return true;
    if (!row.baseline || !["unknown", "running"].includes(row.state)) return false;
    let nativeId = row.resultNativeId || row.nativeId;
    if (row.action === "fork" && !row.resultNativeId) {
      const active = await this.json("/active");
      if (!id.safeParse(active.nativeId).success || active.nativeId === row.nativeId) return false;
      nativeId = active.nativeId;
    }
    const source = await this.json("/conversation?id=" + encodeURIComponent(nativeId));
    this.changed(nativeId);
    if (!operationConfirmation(source, JSON.parse(row.input), JSON.parse(row.baseline)))
      return false;
    if (row.action === "fork")
      this.store.db
        .prepare("UPDATE gpt_native_operations SET resultNativeId=? WHERE id=?")
        .run(nativeId, operationId);
    this.set(operationId, "completed");
    return true;
  }
  async checked(operationId: string) {
    if (this.runningId === operationId) throw fail("GPT_BUSY", "Действие ещё выполняется.");
    const row = this.get(operationId);
    if (row.state !== "unknown") return;
    if (await this.confirm(operationId)) return;
    const active = await this.json("/active"),
      features = await this.json("/native-features");
    if (active.generating || active.requestId || features.generating || !features.ready)
      throw fail("GPT_BUSY", "ChatGPT ещё работает или его состояние недоступно.");
    this.set(operationId, "checked", "Проверено вручную. Повторной отправки не было.");
  }
  async close() {
    await this.work;
  }
}
