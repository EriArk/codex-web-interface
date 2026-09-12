import { createHash } from "node:crypto";
import { HubError } from "@codex-web/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ProjectActions } from "./project-actions.js";
import { ProjectRelays } from "./project-relays.js";
import type { QueueService } from "./queue.js";
import type { Sessions } from "./sessions.js";

export function registerRelays(
  app: FastifyInstance,
  sessions: Sessions,
  actions: ProjectActions,
  queue: QueueService,
) {
  const service = new ProjectRelays(sessions, actions, queue),
    params = z.object({ id: z.string().uuid() });
  app.decorate("projectRelays", service);
  sessions.relayTools = [
    {
      type: "function",
      name: "project_relays",
      description:
        "List owner-linked Codex projects or propose a bounded consultation/work request. Never reads target files or starts code changes. Consult forwards only when the owner trusted that link. During a relay turn return the requested structured decision instead of creating another relay.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["action"],
        properties: {
          action: { type: "string", enum: ["list", "request"] },
          linkId: { type: "string" },
          kind: { type: "string", enum: ["consult", "work"] },
          title: { type: "string" },
          question: { type: "string" },
        },
      },
    },
  ];
  sessions.relayTool = async (thread, request) => {
    if (request.params.tool !== "project_relays") return null;
    const output = (value: unknown, success = true) => ({
      success,
      contentItems: [{ type: "inputText", text: JSON.stringify(value) }],
    });
    try {
      if (
        request.params.turnId !== thread.activeTurnId ||
        !thread.activeTurnId ||
        !(await sessions.owns(thread.id))
      )
        throw new HubError(409, "RELAY_TURN_CHANGED", "Этот ход больше не активен в веб-клиенте.");
      const latest = sessions.thread(thread.id);
      if (latest.activeTurnId !== request.params.turnId || !latest.activeTurnId)
        throw new HubError(409, "RELAY_TURN_CHANGED", "Этот ход больше не активен в веб-клиенте.");
      const input = z
        .discriminatedUnion("action", [
          z.object({ action: z.literal("list") }).strict(),
          z
            .object({
              action: z.literal("request"),
              linkId: z.string().uuid(),
              kind: z.enum(["consult", "work"]),
              title: z.string().min(1).max(160),
              question: z.string().min(1).max(12000),
            })
            .strict(),
        ])
        .parse(request.params.arguments);
      if (input.action === "list")
        return output(
          service
            .links(thread.projectId)
            .filter((l) => l.enabled && (l.sourceId === thread.projectId || l.bidirectional))
            .map((l) => ({
              id: l.id,
              project: service.scope(service.target(l, thread.projectId)).name,
              depth: l.depth,
              autoConsult: l.autoConsult,
            })),
        );
      const callId = z.string().min(1).max(200).parse(request.params.callId),
        digest = createHash("sha256")
          .update(JSON.stringify([thread.id, thread.activeTurnId, callId]))
          .digest("hex"),
        id = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
      const { action: _action, ...body } = input;
      const value = service.create(
        id,
        {
          ...body,
          sourceId: thread.projectId,
          sourceThreadId: thread.id,
          sourceTurnId: thread.activeTurnId,
        },
        true,
      );
      return output({ id: value.id, state: value.state, limit: value.limit });
    } catch (error) {
      return output(
        {
          error: error instanceof HubError ? error.code : "INVALID_RELAY_REQUEST",
          message:
            error instanceof HubError
              ? error.message
              : "Use the declared fields and an owner-linked project.",
        },
        false,
      );
    }
  };
  app.get("/api/workspace/relays", (req) => {
    const q = z
      .object({
        projectId: z.string().min(1).max(100),
        offset: z.coerce.number().int().min(0).max(10000).default(0),
      })
      .strict()
      .parse(req.query);
    return service.page(q.projectId, q.offset);
  });
  app.get("/api/workspace/relays/:id", (req) => service.get(params.parse(req.params).id));
  app.put("/api/workspace/project-links/:id", (req) =>
    service.writeLink(params.parse(req.params).id, req.body),
  );
  app.post("/api/workspace/relays/current", (req) => {
    const body = z
        .object({
          projectId: z.string().min(1).max(100),
          threadId: z.string().uuid(),
          revision: z.number().int().min(0),
          confirm: z.literal(true),
        })
        .strict()
        .parse(req.body),
      scope = service.scope(body.projectId),
      current = actions.context.current(scope);
    if (
      current.threadId !== body.threadId ||
      (!current.explicit && current.revision !== body.revision)
    )
      throw new HubError(409, "PROJECT_CHAT_CHANGED", "Рабочий чат изменился. Обнови панель.");
    actions.context.adopt(scope, body.threadId);
    return actions.context.current(scope);
  });
  app.put("/api/workspace/relays/:id", (req) =>
    service.create(params.parse(req.params).id, req.body),
  );
  app.post("/api/workspace/relays/:id/plan", (req) => {
    z.object({ confirm: z.literal(true) })
      .strict()
      .parse(req.body);
    return service.workPlan(params.parse(req.params).id);
  });
  app.post("/api/workspace/relays/:id/action", (req) => {
    const { revision, action, extra } = z
      .object({
        revision: z.number().int().positive(),
        action: z.enum(["send", "stop", "continue"]),
        extra: z.number().int().min(1).max(10).default(1),
      })
      .strict()
      .parse(req.body);
    return sessions.store.once(
      "relay-action:" + params.parse(req.params).id,
      z.string().uuid().parse(req.headers["idempotency-key"]),
      req.body,
      async () => service.mutate(params.parse(req.params).id, revision, action, extra),
    );
  });
  const timer = setInterval(() => void service.tick(), 3000);
  timer.unref();
  app.addHook("onClose", async () => {
    service.stopped = true;
    clearInterval(timer);
  });
  return service;
}
