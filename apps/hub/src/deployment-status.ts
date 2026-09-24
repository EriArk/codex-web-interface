import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { HubError } from "@codex-web/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Auth } from "./auth.js";
import type { Store } from "./store.js";
import { TeamAuth } from "./team-auth.js";

export function deploymentBlockers(
  store: Pick<Store, "db" | "preferences">,
  terminals?: { busy: number; unknown: number },
) {
  const blockers: { kind: string; count: number; label: string }[] = [];
  const add = (kind: string, sql: string, label: string) => {
    const count = Number(store.db.prepare(sql).get()?.n ?? 0);
    if (count) blockers.push({ kind, count, label });
  };
  add(
    "codex",
    "SELECT count(*) n FROM threads WHERE activitySource!='external' AND (activeTurnId IS NOT NULL OR status IN ('starting','running','waiting_approval','unknown'))",
    "Codex: работа, вопрос или непроверенное состояние",
  );
  add(
    "gpt",
    "SELECT count(*) n FROM gpt_jobs WHERE status IN ('queued','preparing','running','unknown')",
    "GPT: отправка или ответ ещё не завершены",
  );
  add(
    "artifact",
    "SELECT count(*) n FROM artifact_captures WHERE status='capturing'",
    "Файл ещё переносится с компьютера в результаты",
  );
  add(
    "gpt_project",
    "SELECT count(*) n FROM gpt_project_operations WHERE state IN ('pending','unknown')",
    "GPT: изменение проекта ещё не подтверждено",
  );
  add(
    "gpt_native",
    "SELECT count(*) n FROM gpt_native_operations WHERE state IN ('preparing','running','unknown')",
    "GPT: изменение ветки ещё не подтверждено",
  );
  add(
    "gpt_workspace",
    "SELECT count(*) n FROM commands WHERE scope IN ('gpt-workspace','gpt-native-workspace') AND state IN ('pending','unknown')",
    "GPT: изменение расписания или Canvas ещё не подтверждено",
  );
  if (terminals) {
    if (terminals.busy)
      blockers.push({
        kind: "terminal",
        count: terminals.busy,
        label: "В терминале выполняется команда или фоновое задание",
      });
    if (terminals.unknown)
      blockers.push({
        kind: "terminal_unknown",
        count: terminals.unknown,
        label: "Не удалось подтвердить, что терминал свободен",
      });
  } else
    add(
      "terminal_unknown",
      "SELECT count(*) n FROM device_terminals WHERE state='open'",
      "Не удалось подтвердить, что терминал свободен",
    );
  add(
    "receipt",
    "SELECT count(*) n FROM commands WHERE state='pending'",
    "Есть неподтверждённые действия",
  );
  add(
    "setup",
    "SELECT count(*) n FROM project_setup_operations WHERE state IN ('pending','running','unknown')",
    "Создание проекта ещё не подтверждено",
  );
  add(
    "delivery",
    "SELECT count(*) n FROM delivery_operations WHERE state IN ('pending','running','unknown')",
    "Git-действие ещё не подтверждено",
  );
  add(
    "work",
    "SELECT count(*) n FROM project_work_actions WHERE state IN ('dispatching','queued','running','unknown')",
    "Выполняется действие проекта",
  );
  add(
    "reset",
    "SELECT count(*) n FROM usage_reset_operations WHERE state IN ('pending','unknown')",
    "Сброс лимита ещё не подтверждён",
  );
  add(
    "doctor",
    "SELECT count(*) n FROM bridge_doctor_incidents WHERE json_extract(value,'$.delivery') IN ('dispatching','unknown')",
    "Диагностическая отправка ещё не подтверждена",
  );
  // An unavailable/archived existing doctor chat is not an in-flight creation.
  // Its uncertain sends remain guarded by the incident/command receipts above.
  add(
    "doctor_creation",
    "SELECT count(*) n FROM bridge_doctor_config WHERE json_extract(value,'$.state')='creating' OR (json_extract(value,'$.state')='unknown' AND json_extract(value,'$.threadId') IS NULL)",
    "Создание диагностического чата ещё не подтверждено",
  );
  add(
    "preview",
    "SELECT count(*) n FROM gui_previews WHERE json_extract(value,'$.resultId') IS NULL AND json_extract(value,'$.state') IN ('queued','launching','waiting','unknown','captured') AND json_extract(value,'$.expiresAt') > CAST(unixepoch('subsec')*1000 AS INTEGER)",
    "Предпросмотр ещё готовится",
  );
  add(
    "relay",
    "SELECT count(*) n FROM project_relays WHERE state IN ('running','unknown')",
    "Обмен проектов ещё не подтверждён",
  );
  if (store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='project_preparations'").get()) {
    add(
      "project_preparation",
      "SELECT count(*) n FROM project_preparations p WHERE p.state='running' OR (p.state='paused' AND EXISTS (SELECT 1 FROM json_each(json_extract(p.value,'$.steps')) s WHERE json_extract(s.value,'$.sent')=1 AND COALESCE(json_extract(s.value,'$.receipt.state'),'unknown') NOT IN ('completed','failed')))",
      "Подготовка проекта ещё не завершена",
    );
  }
  const preferences = store.preferences();
  if (store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='issue_drawer_batches'").get()) {
    add(
      "issue_dispatch",
      "SELECT count(*) n FROM issue_drawer_batches WHERE state IN ('preparing','running')",
      "Публикуется подборка Issues",
    );
    add(
      "issue_unknown",
      "SELECT count(*) n FROM issue_drawer_items WHERE state='unknown'",
      "Исход публикации Issue ещё не подтверждён",
    );
  }
  const returning = Object.keys(preferences.desktopReturns ?? {}).length;
  if (returning)
    blockers.push({
      kind: "handoff",
      count: returning,
      label: "Передача управления ещё не завершена",
    });
  return blockers;
}
export function registerDeploymentStatus(
  app: FastifyInstance,
  store: Store,
  terminalWork?: () => Promise<{ busy: number; unknown: number }>,
  control?: { auth: Auth; databasePath: string },
) {
  const owner = (req: Parameters<Auth["session"]>[0]) =>
    control?.auth instanceof TeamAuth &&
    control.auth.session(req).user.id === control.auth.registry.ownerId;
  const maintenance = () => {
    try {
      const root = process.env.HUB_RELEASE_ROOT;
      if (!root) return null;
      return JSON.parse(readFileSync(join(root, "maintenance.json"), "utf8"));
    } catch {
      return null;
    }
  };
  app.post("/api/deployment/apply", async (req) => {
    if (!owner(req))
      throw new HubError(403, "OWNER_REQUIRED", "Доступно только владельцу установки.");
    control!.auth.csrf(req);
    const input = z
      .object({
        revision: z.string().regex(/^[a-f0-9]{7,64}$/),
        startedAt: z.number().int(),
        force: z.boolean(),
        confirm: z.boolean(),
      })
      .strict()
      .parse(req.body);
    const pending = maintenance();
    if (
      !pending ||
      pending.state !== "waiting" ||
      pending.revision !== input.revision ||
      pending.startedAt !== input.startedAt
    )
      throw new HubError(409, "UPDATE_CHANGED", "Состояние обновления изменилось. Обнови плашку.");
    if (input.force) {
      if (pending.ownerForce !== 1 || !input.confirm)
        throw new HubError(
          409,
          "UPDATE_CONFIRMATION_REQUIRED",
          "Подтверди остановку активной работы.",
        );
      const path = join(dirname(control!.databasePath), "owner-update-request.json");
      const value = {
        revision: input.revision,
        startedAt: input.startedAt,
        force: true,
        requestedAt: Date.now(),
      };
      writeFileSync(path + ".tmp", JSON.stringify(value), { mode: 0o600 });
      renameSync(path + ".tmp", path);
    }
    return { accepted: true, force: input.force };
  });
  app.get("/api/deployment", async (req) => {
    const root = process.env.HUB_RELEASE_ROOT;
    const readStatus = (file: string) => {
      if (!root) return null;
      try {
        const path = join(root, file);
        if (!existsSync(path) || statSync(path).size > 16384) return null;
        const raw = JSON.parse(readFileSync(path, "utf8"));
        const safe: Record<string, string | number> = {};
        for (const key of [
          "kind",
          "revision",
          "state",
          "startedAt",
          "updatedAt",
          "installedAt",
          "code",
          "id",
        ])
          if (
            typeof raw[key] === "number" ||
            (typeof raw[key] === "string" && /^[a-zA-Z0-9_.:-]{1,100}$/.test(raw[key]))
          )
            safe[key] = raw[key];
        return safe;
      } catch {
        return null;
      }
    };
    return {
      separated: process.env.HUB_ROLE === "engine",
      engineRevision: process.env.HUB_REVISION ?? "development",
      schema: store.schemaVersion,
      web: readStatus("status.json"),
      maintenance: readStatus("maintenance.json"),
      ownerForceAllowed: owner(req) && maintenance()?.ownerForce === 1,
      blockers:
        (req.query as { brief?: string }).brief === "1"
          ? []
          : deploymentBlockers(store, await terminalWork?.()),
    };
  });
}
