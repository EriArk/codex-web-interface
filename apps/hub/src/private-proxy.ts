import { type IncomingMessage, request, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

function headers(req: IncomingMessage) {
  const value = { ...req.headers };
  for (const name of Object.keys(value))
    if (
      name.startsWith("x-forwarded-") ||
      name.startsWith("x-engine-") ||
      name.startsWith("x-user-") ||
      name === "forwarded"
    )
      delete value[name];
  return value;
}
export function proxyPrivateHttp(
  req: IncomingMessage,
  res: ServerResponse,
  socketPath: string,
  authorize: () => void,
) {
  authorize();
  const upstream = request(
    { socketPath, method: req.method, path: req.url, headers: headers(req) },
    (response) => {
      try {
        authorize();
      } catch {
        response.resume();
        upstream.destroy();
        if (!res.headersSent) res.writeHead(401);
        res.end();
        return;
      }
      res.writeHead(response.statusCode ?? 502, response.headers);
      response.on("error", () => res.destroy());
      response.pipe(res);
    },
  );
  upstream.setTimeout(180000, () => upstream.destroy());
  upstream.on("error", () => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(
      JSON.stringify({
        error: {
          code: "PERSONAL_WORKSPACE_UNAVAILABLE",
          message: "Личное пространство переподключается. Проверь состояние отправки.",
        },
      }),
    );
  });
  req.on("aborted", () => upstream.destroy());
  res.on("close", () => {
    if (!res.writableEnded) upstream.destroy();
  });
  req.pipe(upstream);
  return () => {
    upstream.destroy();
    res.destroy();
  };
}
export function proxyPrivateSocket(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  socketPath: string,
  authorize: () => void,
) {
  authorize();
  const upstream = request({ socketPath, method: "GET", path: req.url, headers: headers(req) });
  upstream.setTimeout(10000, () => upstream.destroy());
  upstream.on("upgrade", (res, peer, extra) => {
    try {
      authorize();
    } catch {
      peer.destroy();
      socket.destroy();
      return;
    }
    upstream.setTimeout(0);
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\n${Object.entries(res.headers)
        .map(([key, value]) => `${key}: ${value}`)
        .join("\r\n")}\r\n\r\n`,
    );
    if (extra.length) socket.write(extra);
    if (head.length) peer.write(head);
    peer.on("error", () => socket.destroy());
    socket.on("error", () => peer.destroy());
    peer.on("close", () => socket.destroy());
    socket.on("close", () => peer.destroy());
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
  return () => {
    upstream.destroy();
    socket.destroy();
  };
}
