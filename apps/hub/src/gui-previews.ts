import { createHash } from "node:crypto";
import { guiPreviewMessage, runGuiPreview } from "@codex-web/machines";
import {
  type GuiPreviewOperation,
  guiPreviewActionSchema,
  guiPreviewReceiptSchema,
  HubError,
  type HubEvent,
} from "@codex-web/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Artifacts } from "./artifacts.js";
import type { ProjectContext } from "./project-context.js";
import type { Sessions } from "./sessions.js";

export function registerGuiPreviews(
  app: FastifyInstance,
  sessions: Sessions,
  artifacts: Artifacts,
  projects: ProjectContext,
  probe = runGuiPreview,
) {
  const db = sessions.store.db,
    busy = new Map<string, Promise<GuiPreviewOperation>>(),
    starting = new Map<string, Promise<GuiPreviewOperation>>(),
    startingInputs = new Map<string, string>();
  const keys = z.object({
    id: z.string().min(1).max(100),
    operation: z.string().uuid().optional(),
  });
  const input = z
    .object({ actionId: guiPreviewActionSchema.shape.id, threadId: z.string().min(1).max(100) })
    .strict();
  const context = (id: string) => {
    const project = sessions.project(id);
    if (project.unassigned || sessions.catalog.library.get("project", id)?.deleted)
      throw new HubError(404, "PROJECT_REQUIRED", "Выбери существующий проект.");
    const machine = sessions.catalog.machine(project.machineId);
    return {
      project,
      machine,
      binding: createHash("sha256")
        .update(JSON.stringify([project.id, project.workingDirectory, machine]))
        .digest("hex"),
    };
  };
  const get = (id: string, projectId: string): GuiPreviewOperation => {
    const r = db
      .prepare("SELECT value FROM gui_previews WHERE id=? AND projectId=?")
      .get(id, projectId);
    if (!r) throw new HubError(404, "PREVIEW_MISSING", guiPreviewMessage("PREVIEW_MISSING"));
    return JSON.parse(String(r.value));
  };
  const save = (v: GuiPreviewOperation, binding = "") => {
    db.prepare(
      "INSERT INTO gui_previews VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value,checkedAt=excluded.checkedAt",
    ).run(v.id, v.projectId, binding, JSON.stringify(v), v.createdAt, Date.now());
    return v;
  };
  const bound = (v: GuiPreviewOperation) => {
    const c = context(v.projectId);
    if (db.prepare("SELECT binding FROM gui_previews WHERE id=?").get(v.id)?.binding !== c.binding)
      throw new HubError(
        409,
        "PREVIEW_PROJECT_CHANGED",
        "Папка или компьютер проекта изменились. Предпросмотр относится к прежнему проекту.",
      );
    return c;
  };
  const checked = (v: GuiPreviewOperation, r: unknown) => {
    const p = guiPreviewReceiptSchema.parse(r);
    if (p.id !== v.id || p.actionId !== v.actionId || p.capture !== v.capture)
      throw new HubError(503, "PREVIEW_UNAVAILABLE", guiPreviewMessage("PREVIEW_UNAVAILABLE"));
    return { ...v, ...p, error: p.code ? guiPreviewMessage(p.code) : undefined };
  };
  const refresh = (old: GuiPreviewOperation): Promise<GuiPreviewOperation> => {
    if (busy.has(old.id)) return busy.get(old.id)!;
    const task = (async () => {
      let v = get(old.id, old.projectId);
      const c = bound(v);
      try {
        v = checked(
          v,
          await probe(c.machine, c.project.workingDirectory, { op: "status", id: v.id }),
        );
        bound(v);
        if (v.state === "captured" && !v.resultId) {
          const image = z
            .object({ png: z.string().max(12 * 1024 * 1024) })
            .parse(await probe(c.machine, c.project.workingDirectory, { op: "image", id: v.id }));
          bound(v);
          // The request's thread is frozen, independent of a later project/chat selection.
          const t = sessions.thread(v.threadId);
          if (t.projectId !== v.projectId)
            throw new HubError(409, "PREVIEW_PROJECT_CHANGED", "Диалог предпросмотра изменился.");
          db.exec("BEGIN IMMEDIATE");
          let event: HubEvent;
          try {
            const artifact = artifacts.putPng(v.threadId, image.png);
            const title =
              v.capture === "window"
                ? v.label + " — окно приложения"
                : v.label + " — область рабочего стола";
            const resultId = sessions.store.result(
              v.threadId,
              null,
              `gui-preview:${v.id}`,
              "image",
              title,
              {
                ...artifact,
                previewActionId: v.actionId,
                previewOperationId: v.id,
                capture: v.capture,
              },
            );
            if (!resultId) throw Error("PREVIEW_RESULT_CONFLICT");
            v = { ...v, artifact, resultId };
            save(v);
            const payload = { id: resultId, type: "image" },
              createdAt = new Date().toISOString();
            const row = db
              .prepare(
                "INSERT INTO events(threadId,turnId,type,payload,createdAt) VALUES(?,NULL,'result.created',?,?)",
              )
              .run(v.threadId, JSON.stringify(payload), createdAt);
            event = {
              seq: Number(row.lastInsertRowid),
              threadId: v.threadId,
              turnId: null,
              type: "result.created",
              payload,
              createdAt,
            };
            db.exec("COMMIT");
          } catch (e) {
            db.exec("ROLLBACK");
            throw e;
          }
          sessions.emit("event", event);
        }
        save(v);
        if (v.resultId)
          try {
            await probe(c.machine, c.project.workingDirectory, { op: "ack", id: v.id });
          } catch {}
        return v;
      } catch (e) {
        return save({
          ...get(v.id, v.projectId),
          error: e instanceof HubError ? e.message : guiPreviewMessage("PREVIEW_UNAVAILABLE"),
        });
      }
    })();
    busy.set(old.id, task);
    void task.finally(() => busy.delete(old.id)).catch(() => {});
    return task;
  };
  app.get("/api/projects/:id/gui-previews", async (req) => {
    const { id } = keys.parse(req.params),
      c = context(id);
    const catalog = z
      .object({ installed: z.boolean(), actions: z.array(guiPreviewActionSchema).max(100) })
      .parse(await probe(c.machine, c.project.workingDirectory, { op: "catalog" }));
    if (context(id).binding !== c.binding)
      throw new HubError(409, "PREVIEW_PROJECT_CHANGED", "Проект изменился.");
    return {
      ...catalog,
      threadId: projects.current({ client: "codex", projectId: id, name: c.project.name }).threadId,
      operations: db
        .prepare(
          "SELECT value FROM gui_previews WHERE projectId=? ORDER BY createdAt DESC LIMIT 10",
        )
        .all(id)
        .map((r) => JSON.parse(String(r.value))),
    };
  });
  app.put("/api/projects/:id/gui-previews/:operation", async (req, reply) => {
    const { id, operation } = keys.required().parse(req.params),
      body = input.parse(req.body),
      c = context(id);
    const previous = db.prepare("SELECT projectId FROM gui_previews WHERE id=?").get(operation);
    if (previous) {
      const v = get(operation, id);
      if (v.actionId !== body.actionId || v.threadId !== body.threadId)
        throw new HubError(409, "PREVIEW_KEY_REUSED", guiPreviewMessage("PREVIEW_KEY_REUSED"));
      bound(v);
      return starting.get(operation) ?? v;
    }
    if (starting.has(operation)) {
      if (startingInputs.get(operation) !== JSON.stringify([id, body]))
        throw new HubError(409, "PREVIEW_KEY_REUSED", guiPreviewMessage("PREVIEW_KEY_REUSED"));
      return starting.get(operation);
    }
    if (
      starting.size >= 2 ||
      Number(db.prepare("SELECT count(*) AS n FROM gui_previews").get()?.n) >= 10000
    )
      throw new HubError(429, "PREVIEW_CAPACITY", guiPreviewMessage("PREVIEW_CAPACITY"));
    const task = (async () => {
      if (!projects.thread({ client: "codex", projectId: id, name: c.project.name }, body.threadId))
        throw new HubError(409, "PREVIEW_CHAT", "Сначала открой доступный чат этого проекта.");
      const catalog = z
        .object({ actions: z.array(guiPreviewActionSchema) })
        .parse(await probe(c.machine, c.project.workingDirectory, { op: "catalog" }));
      const action = catalog.actions.find((a) => a.id === body.actionId);
      if (!action) throw new HubError(409, "PREVIEW_ACTION", guiPreviewMessage("PREVIEW_ACTION"));
      if (context(id).binding !== c.binding)
        throw new HubError(409, "PREVIEW_PROJECT_CHANGED", "Проект изменился.");
      let v = save(
        {
          id: operation,
          projectId: id,
          threadId: body.threadId,
          actionId: action.id,
          label: action.label,
          capture: action.capture,
          state: "unknown",
          appOpen: false,
          createdAt: Date.now(),
          expiresAt: Date.now() + 125 * 60000,
        },
        c.binding,
      );
      try {
        v = checked(
          v,
          await probe(c.machine, c.project.workingDirectory, {
            op: "start",
            id: operation,
            actionId: action.id,
          }),
        );
        bound(v);
      } catch (e) {
        v = {
          ...v,
          state:
            e instanceof HubError &&
            ["PREVIEW_ACTION", "PREVIEW_CONFIG", "PREVIEW_BUSY", "PREVIEW_CAPACITY"].includes(
              e.code,
            )
              ? "failed"
              : v.state,
          error: e instanceof HubError ? e.message : guiPreviewMessage("PREVIEW_UNAVAILABLE"),
        };
      }
      save(v);
      return v;
    })();
    starting.set(operation, task);
    startingInputs.set(operation, JSON.stringify([id, body]));
    try {
      reply.code(202);
      return await task;
    } finally {
      starting.delete(operation);
      startingInputs.delete(operation);
    }
  });
  app.get("/api/projects/:id/gui-previews/:operation", (req) => {
    const { id, operation } = keys.required().parse(req.params);
    return refresh(get(operation, id));
  });
  app.post("/api/projects/:id/gui-previews/:operation/stop", async (req) => {
    z.object({ confirm: z.literal(true) })
      .strict()
      .parse(req.body);
    const { id, operation } = keys.required().parse(req.params),
      v = get(operation, id),
      c = bound(v);
    await probe(c.machine, c.project.workingDirectory, { op: "stop", id: operation });
    return refresh(v);
  });
  let closing = false;
  const timer = setInterval(() => {
    if (closing || busy.size || starting.size) return;
    const rows = db
      .prepare(
        "SELECT value FROM gui_previews WHERE json_extract(value,'$.state') NOT IN ('failed') AND json_extract(value,'$.resultId') IS NULL AND json_extract(value,'$.expiresAt')>? ORDER BY checkedAt,createdAt LIMIT 2",
      )
      .all(Date.now());
    for (const row of rows) void refresh(JSON.parse(String(row.value))).catch(() => {});
  }, 2000);
  timer.unref();
  app.addHook("preClose", async () => {
    closing = true;
    clearInterval(timer);
    await Promise.allSettled([...starting.values(), ...busy.values()]);
  });
}
