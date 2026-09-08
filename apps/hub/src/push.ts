import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { HubError } from "@codex-web/shared";
import type { FastifyInstance } from "fastify";
import webpush, { type PushSubscription } from "web-push";
import { z } from "zod";
import type { Auth } from "./auth.js";
import type { Store } from "./store.js";

export interface PushKeys {
  publicKey: string;
  privateKey: string;
}
export function loadPushKeys(path: string): PushKeys {
  if (!existsSync(path))
    writeFileSync(path, JSON.stringify(webpush.generateVAPIDKeys()), { mode: 0o600, flag: "wx" });
  const info = lstatSync(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    (process.platform !== "win32" && info.mode & 0o077)
  )
    throw Error("Push key file must be private");
  return z
    .object({
      publicKey: z.string().regex(/^[A-Za-z0-9_-]{87}$/),
      privateKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    })
    .parse(JSON.parse(readFileSync(path, "utf8")));
}
const categories = z
  .object({ completed: z.boolean(), attention: z.boolean(), errors: z.boolean() })
  .strict();
export function pushEndpoint(value: string): boolean {
  try {
    const u = new URL(value);
    return (
      u.protocol === "https:" &&
      !u.username &&
      !u.password &&
      !u.port &&
      !u.hash &&
      (u.hostname === "web.push.apple.com" ||
        u.hostname.endsWith(".push.apple.com") ||
        u.hostname === "fcm.googleapis.com" ||
        u.hostname === "updates.push.services.mozilla.com" ||
        u.hostname.endsWith(".notify.windows.com"))
    );
  } catch {
    return false;
  }
}
const subscriptionSchema = z
  .object({
    endpoint: z.string().max(4096).refine(pushEndpoint),
    expirationTime: z.number().nullable().optional(),
    keys: z
      .object({
        p256dh: z.string().regex(/^[A-Za-z0-9_-]{87}$/),
        auth: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
      })
      .strict(),
  })
  .strict();
type Notice = {
  id: string;
  client: string;
  target: string;
  category: string;
  kind: string;
  createdAt: number;
};
type Subscription = {
  id: string;
  owner: string;
  value: string;
  categories: string;
  createdAt: number;
};
type Delivery = Notice & {
  subscription: string;
  value: string;
  categories: string;
  attempts: number;
};
export type PushSender = (subscription: PushSubscription, payload: string) => Promise<unknown>;
export type PushOptions = { keys?: PushKeys; send?: PushSender; automatic?: boolean };
const titles: Record<string, string> = {
  completed: "Работа завершена",
  question: "Нужен ответ на вопрос",
  approval: "Нужно разрешение",
  failed: "Не удалось завершить работу",
  unknown: "Проверь состояние работы",
  test: "Уведомления работают",
};
export function pushPayload(n: Notice) {
  return {
    id: n.id,
    title: n.client === "gpt" ? "GPT" : "Codex",
    body: titles[n.kind] ?? "Нужно внимание",
    tag: "work-" + n.id,
    url: "/#notification=" + n.id,
  };
}
function deleted(store: Store, client: string, id: string): boolean {
  const row = store.db
    .prepare("SELECT value FROM library_entities WHERE client=? AND kind='thread' AND id=?")
    .get(client, id);
  return !!(row && JSON.parse(String(row.value)).deleted);
}
export class PushService {
  private stopped = false;
  private timer?: ReturnType<typeof setInterval>;
  private pending?: Promise<void>;
  private readonly presence = new Map<
    string,
    { subscription: string; client: string; target: string; until: number; observedAt: number }
  >();
  readonly send: PushSender;
  constructor(
    readonly store: Store,
    readonly options: PushOptions,
    origin: string,
  ) {
    this.send =
      options.send ??
      ((subscription, payload) =>
        webpush.sendNotification(subscription, payload, {
          TTL: 900,
          urgency: "normal",
          timeout: 5000,
          vapidDetails: { subject: origin, ...options.keys! },
        }));
    // A request may have reached the provider before a Hub crash. Never blindly resend it.
    store.db.prepare("UPDATE push_deliveries SET state='unknown' WHERE state='sending'").run();
    if (options.keys && options.automatic !== false) {
      this.timer = setInterval(() => {
        void this.tick();
      }, 3000);
      this.timer.unref();
    }
  }
  foreground(subscription: string, tab: string, client: string, target: string, visible: boolean) {
    const key = subscription + tab;
    if (!visible) this.presence.delete(key);
    else if (this.presence.has(key) || this.presence.size < 100)
      this.presence.set(key, {
        subscription,
        client,
        target,
        until: Date.now() + 20000,
        observedAt: Date.now(),
      });
  }
  tick(): Promise<void> {
    if (this.stopped || !this.options.keys) return Promise.resolve();
    if (!this.pending)
      this.pending = this.work()
        .catch(() => {
          /* Delivery never owns the work lifecycle. */
        })
        .finally(() => {
          this.pending = undefined;
        });
    return this.pending;
  }
  private async work() {
    const db = this.store.db,
      now = Date.now();
    db.prepare(
      "DELETE FROM push_subscriptions WHERE owner NOT IN (SELECT tokenHash FROM sessions WHERE expires>?)",
    ).run(now);
    db.prepare("DELETE FROM push_notices WHERE createdAt<?").run(now - 30 * 86400000);
    db.prepare(
      "UPDATE push_deliveries SET state='expired' WHERE state='pending' AND notice IN (SELECT id FROM push_notices WHERE createdAt<?)",
    ).run(now - 900000);
    for (const [key, value] of this.presence) if (value.until <= now) this.presence.delete(key);
    const notices = db
      .prepare("SELECT * FROM push_notices WHERE fanned=0 ORDER BY createdAt LIMIT 100")
      .all() as unknown as Notice[];
    for (const notice of notices) {
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const sub of db
          .prepare("SELECT * FROM push_subscriptions WHERE createdAt<=?")
          .all(notice.createdAt) as unknown as Subscription[]) {
          if (!JSON.parse(sub.categories)[notice.category] || now - notice.createdAt > 900000)
            continue;
          db.prepare("INSERT OR IGNORE INTO push_deliveries(notice,subscription) VALUES(?,?)").run(
            notice.id,
            sub.id,
          );
        }
        db.prepare("UPDATE push_notices SET fanned=1 WHERE id=?").run(notice.id);
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    }
    const rows = db
      .prepare(
        "SELECT n.*,d.subscription,d.attempts,s.value,s.categories FROM push_deliveries d JOIN push_notices n ON n.id=d.notice JOIN push_subscriptions s ON s.id=d.subscription JOIN sessions a ON a.tokenHash=s.owner WHERE d.state='pending' AND d.nextAt<=? AND a.expires>? ORDER BY n.createdAt LIMIT 8",
      )
      .all(now, now) as unknown as Delivery[];
    for (const row of rows) {
      if (this.stopped) break;
      // Recheck authorization and preferences after every await, including revocation in another request.
      const sub = db
        .prepare(
          "SELECT s.* FROM push_subscriptions s JOIN sessions a ON a.tokenHash=s.owner WHERE s.id=? AND a.expires>?",
        )
        .get(row.subscription, Date.now()) as unknown as Subscription | undefined;
      if (!sub) continue;
      let nativeTarget = row.target;
      if (row.client === "gpt")
        nativeTarget = String(
          db.prepare("SELECT nativeId FROM gpt_jobs WHERE id=?").get(row.target)?.nativeId ||
            row.target,
        );
      const current =
        row.client === "gpt"
          ? db.prepare("SELECT status FROM gpt_jobs WHERE id=?").get(row.target)
          : db.prepare("SELECT status,codexThreadId FROM threads WHERE id=?").get(row.target);
      const stale =
        row.kind !== "test" &&
        (!current ||
          deleted(this.store, row.client, nativeTarget) ||
          (row.client === "codex" &&
            deleted(this.store, "codex", String(current?.codexThreadId || ""))) ||
          (row.client === "gpt" && current.status !== row.kind) ||
          (row.client === "codex" &&
            ["question", "approval"].includes(row.kind) &&
            current.status !== "waiting_approval") ||
          (row.client === "codex" &&
            row.kind === "unknown" &&
            current.status !== "unknown" &&
            !db
              .prepare(
                "SELECT 1 FROM queue_transfers WHERE threadId=? AND state IN ('unknown','enqueue_unknown')",
              )
              .get(row.target)));
      const visible = [...this.presence.values()].find(
        (p) =>
          p.subscription === row.subscription &&
          p.client === row.client &&
          (p.target === row.target || p.target === nativeTarget) &&
          p.until > Date.now(),
      );
      // A pre-event heartbeat alone cannot prove the page is still visible after an iOS kill.
      // Wait for its next heartbeat, or deliver once the short lease expires.
      if (row.kind !== "test" && visible && visible.observedAt < row.createdAt) {
        db.prepare("UPDATE push_deliveries SET nextAt=? WHERE notice=? AND subscription=?").run(
          visible.until + 1,
          row.id,
          row.subscription,
        );
        continue;
      }
      if (row.kind !== "test" && (!JSON.parse(sub.categories)[row.category] || visible || stale)) {
        db.prepare(
          "UPDATE push_deliveries SET state='skipped' WHERE notice=? AND subscription=?",
        ).run(row.id, row.subscription);
        continue;
      }
      db.prepare(
        "UPDATE push_deliveries SET state='sending',attempts=attempts+1 WHERE notice=? AND subscription=?",
      ).run(row.id, row.subscription);
      try {
        await this.send(JSON.parse(sub.value), JSON.stringify(pushPayload(row)));
        db.prepare("UPDATE push_deliveries SET state='sent' WHERE notice=? AND subscription=?").run(
          row.id,
          row.subscription,
        );
      } catch (e) {
        const status = (e as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410)
          db.prepare("DELETE FROM push_subscriptions WHERE id=?").run(row.subscription);
        else if ([429, 502, 503].includes(status ?? 0) && row.attempts < 2)
          db.prepare(
            "UPDATE push_deliveries SET state='pending',nextAt=? WHERE notice=? AND subscription=?",
          ).run(Date.now() + 30000 * (row.attempts + 1), row.id, row.subscription);
        else
          db.prepare(
            "UPDATE push_deliveries SET state='unknown' WHERE notice=? AND subscription=?",
          ).run(row.id, row.subscription);
      }
    }
  }
  async close() {
    this.stopped = true;
    clearInterval(this.timer);
    await this.pending;
  }
}
export function registerPush(
  app: FastifyInstance,
  store: Store,
  auth: Auth,
  origin: string,
  options: PushOptions = {},
) {
  const service = new PushService(store, options, origin);
  const owned = (id: string, owner: string) =>
    store.db
      .prepare("SELECT * FROM push_subscriptions WHERE id=? AND owner=?")
      .get(id, owner) as unknown as Subscription | undefined;
  app.get("/api/push", async (req) => {
    const owner = auth.session(req).tokenHash;
    const { id } = z
      .object({
        id: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
      })
      .parse(req.query);
    const row = id ? owned(id, owner) : undefined;
    return {
      available: !!options.keys,
      publicKey: options.keys?.publicKey,
      enabled: !!row,
      categories: row
        ? JSON.parse(row.categories)
        : { completed: true, attention: true, errors: true },
    };
  });
  app.post("/api/push", async (req) => {
    if (!options.keys) throw new HubError(503, "PUSH_UNAVAILABLE", "Уведомления пока недоступны.");
    const body = z
        .object({ subscription: subscriptionSchema, categories })
        .strict()
        .parse(req.body),
      owner = auth.session(req).tokenHash;
    const id = createHash("sha256").update(body.subscription.endpoint).digest("hex");
    if (
      !store.db.prepare("SELECT id FROM push_subscriptions WHERE id=?").get(id) &&
      Number(store.db.prepare("SELECT count(*) n FROM push_subscriptions").get()?.n) >= 16
    )
      throw new HubError(409, "PUSH_LIMIT", "Достигнут лимит устройств с уведомлениями.");
    const old = owned(id, owner);
    // A fresh login must explicitly re-enable this browser. Old session delivery receipts never transfer.
    if (!old) store.db.prepare("DELETE FROM push_subscriptions WHERE id=?").run(id);
    store.db
      .prepare(
        "INSERT INTO push_subscriptions VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value,categories=excluded.categories",
      )
      .run(
        id,
        owner,
        JSON.stringify(body.subscription),
        JSON.stringify(body.categories),
        Date.now(),
      );
    return { id, enabled: true };
  });
  app.delete("/api/push/:id", async (req) => {
    const { id } = z.object({ id: z.string().regex(/^[a-f0-9]{64}$/) }).parse(req.params);
    store.db
      .prepare("DELETE FROM push_subscriptions WHERE id=? AND owner=?")
      .run(id, auth.session(req).tokenHash);
    return { ok: true };
  });
  app.post("/api/push/presence", async (req) => {
    const b = z
      .object({
        id: z.string().regex(/^[a-f0-9]{64}$/),
        tab: z.string().uuid(),
        client: z.enum(["codex", "gpt"]),
        target: z.string().max(100),
        visible: z.boolean(),
      })
      .strict()
      .parse(req.body);
    if (owned(b.id, auth.session(req).tokenHash))
      service.foreground(b.id, b.tab, b.client, b.target, b.visible);
    return { ok: true };
  });
  app.post(
    "/api/push/test",
    { config: { rateLimit: { max: 3, timeWindow: "1 minute" } } },
    async (req) => {
      const { id } = z
        .object({ id: z.string().regex(/^[a-f0-9]{64}$/) })
        .strict()
        .parse(req.body);
      if (!owned(id, auth.session(req).tokenHash))
        throw new HubError(404, "PUSH_MISSING", "Сначала включи уведомления.");
      const notice = randomUUID().replaceAll("-", "");
      store.db
        .prepare("INSERT INTO push_notices VALUES(?,?, 'codex','', 'attention','test',?,1)")
        .run(notice, "test:" + notice, Date.now());
      store.db
        .prepare("INSERT INTO push_deliveries(notice,subscription) VALUES(?,?)")
        .run(notice, id);
      void service.tick();
      return { ok: true };
    },
  );
  app.get("/api/push/open/:id", async (req) => {
    const { id } = z.object({ id: z.string().regex(/^[a-f0-9]{32}$/) }).parse(req.params);
    const n = store.db.prepare("SELECT * FROM push_notices WHERE id=?").get(id) as unknown as
      | Notice
      | undefined;
    if (!n) throw new HubError(404, "PUSH_EXPIRED", "Уведомление больше недоступно.");
    if (n.kind === "test") return { client: "codex" };
    if (n.client === "codex") {
      const t = store.thread(n.target);
      if (deleted(store, "codex", t.id) || deleted(store, "codex", t.codexThreadId))
        throw new HubError(404, "PUSH_EXPIRED", "Диалог больше недоступен.");
      return { client: "codex", threadId: t.id, projectId: t.projectId };
    }
    const job = store.db.prepare("SELECT id,nativeId FROM gpt_jobs WHERE id=?").get(n.target);
    if (!job || deleted(store, "gpt", String(job.nativeId || "")))
      throw new HubError(404, "PUSH_EXPIRED", "Диалог больше недоступен.");
    return { client: "gpt", jobId: job.id, nativeId: job.nativeId || "" };
  });
  return service;
}
