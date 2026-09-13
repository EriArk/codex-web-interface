import { createHash } from "node:crypto";
import type { CodexClient } from "@codex-web/codex";
import { HubError, type NativePlanAction } from "@codex-web/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ProjectContext } from "./project-context.js";
import type { Sessions } from "./sessions.js";

const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const record = (v: unknown): Record<string, any> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, any>) : {};
// Installed desktop 26.908: its plan button sends this exact follow-up in default mode.
export const nativePlanPrompt = (text: string) => `PLEASE IMPLEMENT THIS PLAN:\n${text}`;
const stale = () =>
  new HubError(
    409,
    "NATIVE_PLAN_CHANGED",
    "План или рабочий чат изменился. Обнови диалог перед запуском.",
  );
const clientId = (key: string) =>
  `${key.slice(0, 8)}-${key.slice(8, 12)}-4${key.slice(13, 16)}-a${key.slice(17, 20)}-${key.slice(20, 32)}`;
const busy = ["running", "starting", "waiting_approval", "unknown"];

/** A native Plan transition, deliberately independent from saved workspace Plans. */
export class NativePlans {
  private dispatching = new Set<string>();
  constructor(
    readonly sessions: Sessions,
    readonly context: ProjectContext,
  ) {}
  private get store() {
    return this.sessions.store;
  }
  private source(id: string) {
    const thread = this.sessions.thread(id);
    const plan = this.store.db
      .prepare(
        "SELECT * FROM messages WHERE threadId=? AND role='assistant' AND phase='plan' AND turnId IS NOT NULL AND length(trim(text))>0 ORDER BY firstSeq DESC LIMIT 1",
      )
      .get(id);
    if (!plan) return null;
    const key = hash([thread.codexThreadId, plan.turnId, plan.id, plan.text]);
    const receipt = this.store.db
      .prepare("SELECT state,response FROM commands WHERE scope=? AND key=?")
      .get(`native-plan:${id}`, key);
    return { thread, plan, key, receipt };
  }
  get(id: string, ignoreReceipt = false): NativePlanAction | null {
    const source = this.source(id);
    if (!source) return null;
    const { thread, plan, key, receipt } = source;
    const base = {
      threadId: id,
      messageId: String(plan.id),
      turnId: String(plan.turnId),
      revision: key,
    };
    if (receipt && !ignoreReceipt)
      return {
        ...base,
        state:
          receipt.state === "complete"
            ? "submitted"
            : receipt.state === "pending"
              ? "starting"
              : "unknown",
        message:
          receipt.state === "complete"
            ? "Реализация запущена в этом чате."
            : receipt.state === "pending"
              ? "Запускаем реализацию…"
              : "Запуск не подтверждён. Проверь состояние; повторной отправки не будет.",
      };
    const completion = this.store.db
      .prepare(
        "SELECT seq,payload FROM events WHERE threadId=? AND turnId=? AND type='turn.completed' ORDER BY seq DESC LIMIT 1",
      )
      .get(id, String(plan.turnId));
    if (!completion || record(JSON.parse(String(completion.payload))).status !== "completed")
      return null;
    const latest = this.store.db
      .prepare(
        "SELECT 1 FROM events WHERE threadId=? AND seq>? AND type IN ('turn.started','user.message') LIMIT 1",
      )
      .get(id, Number(completion.seq));
    if (latest) return null;
    const start = this.store.db
      .prepare(
        "SELECT e.payload FROM events e JOIN messages m ON m.threadId=e.threadId AND m.id=json_extract(e.payload,'$.id') WHERE e.threadId=? AND m.turnId=? AND e.type='user.message' ORDER BY e.seq ASC LIMIT 1",
      )
      .get(id, String(plan.turnId));
    const mode = start
      ? record(record(JSON.parse(String(start.payload))).settings).mode
      : undefined;
    if (mode && mode !== "plan") return null;
    if (!mode)
      return {
        ...base,
        state: "unavailable",
        message:
          "Для этого старого плана не сохранён нативный режим. Продолжи его обычным сообщением в режиме работы.",
      };
    const project = this.sessions.project(thread.projectId);
    if (project.unassigned)
      return {
        ...base,
        state: "unavailable",
        message: "Для запуска плана нужен рабочий чат проекта.",
      };
    const scope = { client: "codex" as const, projectId: thread.projectId, name: project.name };
    const current = this.context.current(scope);
    if (current.threadId !== id)
      return { ...base, state: "unavailable", message: "Рабочим выбран другой чат проекта." };
    if (busy.includes(thread.status))
      return {
        ...base,
        state: "unavailable",
        message: "Дождись завершения работы и проверь состояние диалога.",
      };
    const settings = this.store.threadSettings(id);
    if (!settings)
      return { ...base, state: "unavailable", message: "Выбери модель и настройки выполнения." };
    return {
      ...base,
      state: "ready",
      revision: hash([
        key,
        completion.seq,
        plan.lastSeq,
        thread.projectId,
        thread.codexThreadId,
        project.machineId,
        thread.workingDirectory || project.workingDirectory,
        current.revision,
        settings,
      ]),
      message: "",
    };
  }
  private assert(id: string, revision: string) {
    const view = this.get(id);
    if (view?.state !== "ready" || view.revision !== revision) throw stale();
    const project = this.sessions.project(this.sessions.thread(id).projectId);
    this.context.assertProject({ client: "codex", projectId: project.id, name: project.name });
    return view;
  }
  async implement(id: string, revision: string) {
    const source = this.source(id);
    if (!source) throw stale();
    // A plan has one durable operation even across different tabs/request IDs.
    if (source.receipt) return this.get(id);
    this.assert(id, revision);
    const prompt = nativePlanPrompt(String(source.plan.text));
    if (prompt.length > 200000)
      throw new HubError(400, "NATIVE_PLAN_TOO_LARGE", "План слишком большой для одного хода.");
    this.dispatching.add(id);
    try {
      await this.store.once(`native-plan:${id}`, source.key, { revision }, () =>
        this.sessions.startTurn(
          id,
          prompt,
          { ...this.store.threadSettings(id)!, mode: "default" },
          [],
          clientId(source.key),
          false,
          {
            beforeSubmit: async (rpc) => {
              const latest = await this.latest(rpc, source.thread.codexThreadId);
              const plan = Array.isArray(latest.items)
                ? latest.items.filter((i: any) => i?.type === "plan").at(-1)
                : undefined;
              if (
                latest.id !== source.plan.turnId ||
                latest.status !== "completed" ||
                !plan ||
                plan.id !== source.plan.id ||
                plan.text !== source.plan.text
              )
                throw stale();
              const queue = await rpc.request("thread/queue/list", {
                threadId: source.thread.codexThreadId,
                limit: 1,
              });
              if (!Array.isArray(queue.data) || queue.data.length || queue.nextCursor)
                throw new HubError(
                  409,
                  "NATIVE_PLAN_QUEUE_BUSY",
                  "В очереди есть сообщения. Дождись их выполнения и пересмотри план.",
                );
            },
            // Exclude our pending receipt while rechecking every source boundary inside the writer lock.
            beforeCommit: () => {
              const reviewed = this.get(id, true);
              if (reviewed?.state !== "ready" || reviewed.revision !== revision) throw stale();
            },
          },
        ),
      );
    } finally {
      this.dispatching.delete(id);
    }
    return this.get(id);
  }
  private async latest(rpc: CodexClient, threadId: string) {
    const response = await rpc.request("thread/turns/list", {
      threadId,
      limit: 1,
      itemsView: "full",
      sortDirection: "desc",
    });
    if (!Array.isArray(response.data) || response.data.length !== 1)
      throw new HubError(
        502,
        "NATIVE_PLAN_STATE_UNKNOWN",
        "Codex не подтвердил последний ход. Обнови диалог.",
      );
    return record(response.data[0]);
  }
  async check(id: string) {
    const source = this.source(id);
    if (!source?.receipt || source.receipt.state === "complete" || this.dispatching.has(id))
      return this.get(id);
    const rpc = await this.sessions.queueClient(id);
    const turn = await this.latest(rpc, source.thread.codexThreadId);
    const match =
      Array.isArray(turn.items) &&
      turn.items.some((raw: unknown) => {
        const item = record(raw);
        return (
          item.type === "userMessage" &&
          (item.clientId === clientId(source.key) || item.id === clientId(source.key)) &&
          Array.isArray(item.content) &&
          item.content.length === 1 &&
          item.content[0]?.type === "text" &&
          item.content[0]?.text === nativePlanPrompt(String(source.plan.text))
        );
      });
    this.sessions.authorizeExecution();
    if (match && typeof turn.id === "string")
      this.store.db
        .prepare("UPDATE commands SET state='complete',response=? WHERE scope=? AND key=?")
        .run(
          JSON.stringify({ turnId: turn.id, status: turn.status }),
          `native-plan:${id}`,
          source.key,
        );
    return this.get(id);
  }
}

export function registerNativePlans(app: FastifyInstance, service: NativePlans) {
  const id = (params: unknown) => z.object({ id: z.string().min(1).max(100) }).parse(params).id;
  app.get("/api/threads/:id/native-plan", async (req) => ({ action: service.get(id(req.params)) }));
  app.post("/api/threads/:id/native-plan", async (req) => {
    const body = z
      .object({ revision: z.string().regex(/^[a-f0-9]{64}$/) })
      .strict()
      .parse(req.body);
    return { action: await service.implement(id(req.params), body.revision) };
  });
  app.post("/api/threads/:id/native-plan/check", async (req) => ({
    action: await service.check(id(req.params)),
  }));
}
