import { createReadStream } from "node:fs";
import { createServer, type IncomingMessage, request, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { extname } from "node:path";
import type { HubConfig } from "@codex-web/shared";
import helmet from "@fastify/helmet";
import Fastify from "fastify";
import { engineInfo } from "./engine-client.js";
import { compatible, currentRelease, publicFile } from "./web-releases.js";
import { webSecurity } from "./web-security.js";

const apiPath = (url: string) => {
  try {
    return (
      url.startsWith("/api/") && new URL(url, "http://gateway.invalid").pathname.startsWith("/api/")
    );
  } catch {
    return false;
  }
};
function forwardHeaders(req: IncomingMessage) {
  const headers = { ...req.headers };
  // The private engine remains the authentication/CSRF boundary. The gateway
  // never adds credentials or trusts caller-supplied forwarding/identity headers.
  for (const name of Object.keys(headers))
    if (name.startsWith("x-forwarded-") || name === "forwarded" || name.startsWith("x-engine-"))
      delete headers[name];
  return headers;
}
export async function createWebGateway(
  config: HubConfig,
  options: { socketPath: string; releaseRoot: string },
) {
  const { socketPath, releaseRoot } = options;
  const initial = await engineInfo(socketPath);
  compatible(currentRelease(releaseRoot), initial);
  const clients = new Set<Socket>();
  const proxy = (req: IncomingMessage, res: ServerResponse) => {
    const upstream = request(
      { socketPath, method: req.method, path: req.url, headers: forwardHeaders(req) },
      (reply) => {
        res.writeHead(reply.statusCode ?? 502, reply.headers);
        reply.on("error", () => res.destroy());
        reply.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (res.headersSent) return res.destroy();
      res.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(
        JSON.stringify({
          error: {
            code: "ENGINE_UNAVAILABLE",
            message: "Связь с движком восстанавливается. Проверь состояние отправки.",
          },
        }),
      );
    });
    upstream.setTimeout(120000, () => upstream.destroy());
    req.on("aborted", () => upstream.destroy());
    res.on("close", () => {
      if (!res.writableEnded) upstream.destroy();
    });
    req.pipe(upstream); // Stream uploads/downloads. Never retry a request here.
  };
  const app = Fastify({
    serverFactory: (handler) =>
      createServer((req, res) => {
        if (apiPath(req.url ?? "")) proxy(req, res);
        else handler(req, res);
      }),
  });
  app.server.on("connection", (socket) => {
    clients.add(socket);
    socket.once("close", () => clients.delete(socket));
  });
  app.server.on("upgrade", (req, socket, head) => {
    if (!apiPath(req.url ?? "")) {
      socket.destroy();
      return;
    }
    const upstream = request({
      socketPath,
      method: "GET",
      path: req.url,
      headers: forwardHeaders(req),
    });
    upstream.setTimeout(10000, () => upstream.destroy());
    upstream.on("upgrade", (res, peer, extra) => {
      upstream.setTimeout(0);
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\n${Object.entries(res.headers)
          .map(([k, v]) => `${k}: ${v}`)
          .join("\r\n")}\r\n\r\n`,
      );
      if (extra.length) socket.write(extra);
      if (head.length) peer.write(head);
      peer.on("error", () => socket.destroy());
      socket.on("error", () => peer.destroy());
      socket.on("close", () => peer.destroy());
      peer.on("close", () => socket.destroy());
      peer.pipe(socket);
      socket.pipe(peer);
    });
    upstream.on("response", (res) => {
      socket.end(
        `HTTP/1.1 ${res.statusCode ?? 502} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
      );
      res.resume();
    });
    upstream.on("error", () => socket.destroy());
    socket.on("close", () => upstream.destroy());
    upstream.end();
  });
  await app.register(helmet, webSecurity(config));
  app.get("/*", async (req, reply) => {
    const path = req.url.split("?")[0] ?? "/";
    if (path.startsWith("/internal/")) return reply.code(404).send();
    try {
      const release = currentRelease(releaseRoot),
        file = publicFile(releaseRoot, release, path);
      if (!file) return reply.code(404).send();
      const mime: Record<string, string> = {
        ".html": "text/html",
        ".js": "text/javascript",
        ".css": "text/css",
        ".json": "application/json",
        ".webmanifest": "application/manifest+json",
        ".png": "image/png",
        ".svg": "image/svg+xml",
        ".ico": "image/x-icon",
        ".woff2": "font/woff2",
        ".jpeg": "image/jpeg",
        ".jpg": "image/jpeg",
      };
      return reply
        .header(
          "Cache-Control",
          path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-store",
        )
        .type(mime[extname(file)] ?? "application/octet-stream")
        .send(createReadStream(file));
    } catch {
      return reply
        .code(503)
        .header("Cache-Control", "no-store")
        .send("Интерфейс обновляется. Повтори подключение.");
    }
  });
  app.addHook("preClose", async () => {
    for (const client of clients) client.destroy();
  });
  return app;
}
