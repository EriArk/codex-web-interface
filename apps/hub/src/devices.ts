import { randomBytes, randomUUID } from "node:crypto";
import {
  type DeviceConfig,
  type DeviceSnapshot,
  type DeviceTerminalInfo,
  deviceActionSchema,
  type HubConfig,
  HubError,
  NotSubmittedError,
} from "@codex-web/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { type IPty, spawn as spawnPty } from "node-pty";
import type { WebSocket } from "ws";
import { z } from "zod";
import { type Auth, tokenHash } from "./auth.js";
import { probeDevice, terminalCommand } from "./device-transport.js";
import type { Store } from "./store.js";

export interface DeviceDependencies {
  spawn?: (args: string[]) => IPty;
  probe?: (device: DeviceConfig) => Promise<DeviceSnapshot>;
}
type LiveTerminal = {
  info: DeviceTerminalInfo;
  owner: string;
  pty: IPty;
  buffer: string;
  clients: Set<WebSocket>;
  created: number;
};
const params = (req: FastifyRequest) =>
  z.object({ id: z.string().min(1).max(100) }).parse(req.params).id;
const frame = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ack"), length: z.number().int().positive().max(32768) }),
  z.object({ type: z.literal("input"), data: z.string().max(1024) }),
  z.object({
    type: z.literal("resize"),
    cols: z.number().int().min(2).max(300),
    rows: z.number().int().min(2).max(150),
  }),
]);
const BUFFER = 64 * 1024;
export function registerDevices(
  app: FastifyInstance,
  config: HubConfig,
  store: Store,
  auth: Auth,
  deps: DeviceDependencies = {},
) {
  const live = new Map<string, LiveTerminal>();
  const flow = new Map<WebSocket, { queue: string; outstanding: number }>();
  const tickets = new Map<string, { id: string; owner: string; expires: number }>();
  const cache = new Map<string, { until: number; pending: Promise<DeviceSnapshot> }>();
  store.db.prepare("UPDATE device_terminals SET state='closed' WHERE state='open'").run();
  store.db
    .prepare("DELETE FROM device_terminals WHERE state='closed' AND createdAt < ?")
    .run(new Date(Date.now() - 7 * 86400000).toISOString());
  const device = (id: string) => {
    const value = config.devices?.find((d) => d.id === id);
    if (!value) throw new HubError(404, "DEVICE_NOT_FOUND", "Устройство не найдено.");
    return value;
  };
  const record = (id: string, owner: string) => {
    const row = store.db
      .prepare(
        "SELECT id,deviceId,title,state,createdAt,exitCode FROM device_terminals WHERE id=? AND owner=?",
      )
      .get(id, owner);
    if (!row) throw new HubError(404, "TERMINAL_NOT_FOUND", "Терминал не найден.");
    return row as unknown as DeviceTerminalInfo;
  };
  const send = (socket: WebSocket, value: unknown) => {
    if (socket.readyState !== 1) return;
    if (socket.bufferedAmount > 128 * 1024) {
      socket.close(1013, "Reconnect");
      return;
    }
    socket.send(JSON.stringify(value));
  };
  const pump = (socket: WebSocket) => {
    const f = flow.get(socket);
    if (!f) return;
    while (f.queue.length && f.outstanding < 32768 && socket.readyState === 1) {
      const chunk = f.queue.slice(0, Math.min(4096, 32768 - f.outstanding));
      f.queue = f.queue.slice(chunk.length);
      f.outstanding += chunk.length;
      send(socket, { type: "output", data: chunk });
    }
  };
  const output = (socket: WebSocket, data: string) => {
    const f = flow.get(socket);
    if (!f || socket.readyState !== 1) return;
    if (f.queue.length + data.length > BUFFER) {
      socket.close(1013, "Reconnect");
      return;
    }
    f.queue += data;
    pump(socket);
  };
  const finish = (terminal: LiveTerminal, code: number | null) => {
    if (terminal.info.state === "closed") return;
    terminal.info = { ...terminal.info, state: "closed", exitCode: code };
    store.db
      .prepare("UPDATE device_terminals SET state='closed',exitCode=? WHERE id=?")
      .run(code, terminal.info.id);
    for (const socket of terminal.clients) send(socket, { type: "exit", exitCode: code });
    // Keep a bounded final screen for reconnection, but no unlimited retained sessions.
    const closed = [...live.values()].filter((t) => t.info.state === "closed");
    for (const old of closed.slice(0, Math.max(0, closed.length - 12))) {
      for (const socket of old.clients) socket.close(1000);
      live.delete(old.info.id);
    }
  };
  const close = (terminal: LiveTerminal) => {
    try {
      terminal.pty.kill();
    } catch {}
    finish(terminal, null);
  };
  const sweep = () => {
    for (const [key, ticket] of tickets) if (ticket.expires < Date.now()) tickets.delete(key);
    for (const terminal of live.values()) {
      const valid = store.db
        .prepare("SELECT 1 FROM sessions WHERE tokenHash=? AND expires>?")
        .get(terminal.owner, Date.now());
      if (!valid) {
        close(terminal);
        for (const socket of terminal.clients) socket.close(1008, "Session ended");
        live.delete(terminal.info.id);
      } else if (terminal.created + 24 * 3600000 < Date.now()) close(terminal);
    }
  };
  const interval = setInterval(sweep, 10000);
  interval.unref();
  app.addHook("onClose", async () => {
    clearInterval(interval);
    for (const t of live.values()) {
      close(t);
      for (const s of t.clients) s.close(1001);
    }
    live.clear();
  });
  app.get("/api/devices", async () => ({
    devices: (config.devices ?? []).map(({ id, name, platform, power, mounts }) => ({
      id,
      name,
      platform,
      power,
      mounts,
    })),
  }));
  app.get("/api/devices/:id/snapshot", async (req) => {
    const d = device(params(req));
    let entry = cache.get(d.id);
    if (!entry || entry.until < Date.now()) {
      const pending = (deps.probe ?? probeDevice)(d).catch(() => ({
        checkedAt: Date.now(),
        online: false,
        error: "Не удалось прочитать состояние устройства.",
        disks: [],
        temperatures: [],
      }));
      entry = { until: Date.now() + 15000, pending };
      cache.set(d.id, entry);
    }
    return entry.pending;
  });
  app.get("/api/devices/:id/terminals", async (req) => {
    const d = device(params(req)),
      owner = auth.session(req).tokenHash;
    return {
      terminals: store.db
        .prepare(
          "SELECT id,deviceId,title,state,createdAt,exitCode FROM device_terminals WHERE deviceId=? AND owner=? ORDER BY createdAt DESC LIMIT 12",
        )
        .all(d.id, owner),
    };
  });
  app.post("/api/devices/:id/terminals", async (req) => {
    const d = device(params(req)),
      owner = auth.session(req).tokenHash;
    const action = deviceActionSchema.parse(req.body),
      args = terminalCommand(d, action);
    const key = z.string().uuid().parse(req.headers["idempotency-key"]);
    return store.once(`device-terminal:${owner}`, key, { deviceId: d.id, action }, async () => {
      sweep();
      if ([...live.values()].filter((t) => t.info.state === "open").length >= 8)
        throw new NotSubmittedError(
          new HubError(409, "DEVICE_TERMINAL_LIMIT", "Закрой один из открытых терминалов."),
        );
      const info: DeviceTerminalInfo = {
        id: randomUUID(),
        deviceId: d.id,
        title:
          action.kind === "shell"
            ? d.platform === "windows"
              ? "PowerShell"
              : "Терминал"
            : action.kind === "mount"
              ? "Сетевой диск"
              : action.kind === "restart"
                ? "Перезагрузка"
                : "Выключение",
        state: "open",
        createdAt: new Date().toISOString(),
        exitCode: null,
      };
      const pty = (
        deps.spawn ??
        ((argv) =>
          spawnPty("ssh", argv, {
            name: "xterm-256color",
            cols: 100,
            rows: 30,
            cwd: process.env.HOME ?? "/tmp",
            env: {
              PATH: process.env.PATH ?? "/usr/bin:/bin",
              HOME: process.env.HOME ?? "/tmp",
              LANG: "C.UTF-8",
              TERM: "xterm-256color",
            },
          }))
      )(args);
      const terminal: LiveTerminal = {
        info,
        owner,
        pty,
        buffer: "",
        clients: new Set(),
        created: Date.now(),
      };
      try {
        store.db
          .prepare("INSERT INTO device_terminals VALUES(?,?,?,?,?,?,NULL)")
          .run(info.id, d.id, owner, info.title, "open", info.createdAt);
      } catch (e) {
        pty.kill();
        throw e;
      }
      live.set(info.id, terminal);
      pty.onData((data) => {
        terminal.buffer = (terminal.buffer + data).slice(-BUFFER);
        for (const s of terminal.clients) output(s, data);
      });
      pty.onExit(({ exitCode }) => finish(terminal, exitCode));
      return info;
    });
  });
  app.delete("/api/device-terminals/:id", async (req) => {
    const info = record(params(req), auth.session(req).tokenHash),
      t = live.get(info.id);
    if (t) close(t);
    return { ok: true };
  });
  app.post("/api/device-terminals/:id/ticket", async (req) => {
    const owner = auth.session(req).tokenHash,
      info = record(params(req), owner);
    sweep();
    if (!live.has(info.id))
      throw new HubError(410, "TERMINAL_ENDED", "Сессия завершена. Открой новый терминал.");
    if (tickets.size >= 100)
      throw new HubError(429, "TERMINAL_BUSY", "Повтори подключение через несколько секунд.");
    const token = randomBytes(32).toString("base64url");
    tickets.set(tokenHash(token), { id: info.id, owner, expires: Date.now() + 10000 });
    return { ticket: token };
  });
  app.get("/api/device-terminals/:id/socket", { websocket: true }, (socket, req) => {
    let owner: string;
    try {
      auth.requireOrigin(req);
      owner = auth.session(req).tokenHash;
      record(params(req), owner);
    } catch {
      socket.close(1008);
      return;
    }
    let attached: LiveTerminal | undefined;
    const timer = setTimeout(() => {
      if (!attached) socket.close(1008);
    }, 10000);
    let received = 0,
      windowAt = Date.now();
    socket.on("message", (raw) => {
      try {
        if (auth.session(req).tokenHash !== owner) throw new Error("Session ended");
        const msg = JSON.parse(raw.toString());
        if (!attached) {
          const token = z
            .object({ ticket: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
            .parse(msg).ticket;
          const hash = tokenHash(token),
            ticket = tickets.get(hash);
          tickets.delete(hash);
          if (
            !ticket ||
            ticket.owner !== owner ||
            ticket.id !== params(req) ||
            ticket.expires < Date.now()
          )
            throw new Error("Invalid ticket");
          const t = live.get(ticket.id);
          if (!t || t.clients.size >= 3) throw new Error("No terminal");
          attached = t;
          t.clients.add(socket);
          flow.set(socket, { queue: "", outstanding: 0 });
          clearTimeout(timer);
          send(socket, { type: "ready", state: t.info.state });
          // Browser acknowledges xterm parsing, not just network receipt.
          output(socket, t.buffer);
          if (t.info.state === "closed") send(socket, { type: "exit", exitCode: t.info.exitCode });
          return;
        }
        if (Date.now() - windowAt >= 1000) {
          windowAt = Date.now();
          received = 0;
        }
        received += raw.toString().length;
        if (received > 65536) throw new Error("Input limit");
        const value = frame.parse(msg);
        if (value.type === "ack") {
          const f = flow.get(socket);
          if (!f || value.length > f.outstanding) throw new Error("Invalid acknowledgement");
          f.outstanding -= value.length;
          pump(socket);
          return;
        }
        if (attached.info.state !== "open") return;
        if (value.type === "input") attached.pty.write(value.data);
        else attached.pty.resize(value.cols, value.rows);
      } catch {
        socket.close(1008, "Reconnect");
      }
    });
    socket.on("close", () => {
      clearTimeout(timer);
      attached?.clients.delete(socket);
      flow.delete(socket);
    });
    socket.on("error", () => {});
  });
  return { sweep };
}
