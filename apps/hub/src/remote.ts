import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { StringDecoder } from "node:string_decoder";
import type { MachineConfig } from "@codex-web/shared";
import { HubError } from "@codex-web/shared";
import type { WebSocket } from "ws";

export const instruction = (...parts: string[]): string =>
  `${parts.map((p) => `${Array.from(p).length}.${p}`).join(",")};`;
export class GuacParser {
  private buffer = "";
  feed(data: string): string[][] {
    this.buffer += data;
    if (this.buffer.length > 4 * 1024 * 1024) throw new Error("Guacamole frame too large");
    const messages: string[][] = [];
    for (;;) {
      let pos = 0;
      const parts: string[] = [];
      let complete = false;
      for (;;) {
        const dot = this.buffer.indexOf(".", pos);
        if (dot < 0) break;
        const lengthText = this.buffer.slice(pos, dot);
        if (!/^[0-9]{1,7}$/.test(lengthText)) throw new Error("Invalid Guacamole length");
        const length = Number(lengthText);
        if (length > 2 * 1024 * 1024) throw new Error("Guacamole element too large");
        let end = dot + 1,
          count = 0;
        while (count < length && end < this.buffer.length) {
          end += (this.buffer.codePointAt(end) ?? 0) > 0xffff ? 2 : 1;
          count++;
        }
        if (count !== length || end >= this.buffer.length) break;
        const delimiter = this.buffer[end];
        if (delimiter !== "," && delimiter !== ";") throw new Error("Invalid Guacamole delimiter");
        parts.push(this.buffer.slice(dot + 1, end));
        pos = end + 1;
        if (parts.length > 256) throw new Error("Too many Guacamole elements");
        if (delimiter === ";") {
          complete = true;
          break;
        }
      }
      if (!complete) break;
      messages.push(parts);
      this.buffer = this.buffer.slice(pos);
    }
    return messages;
  }
  takeRemainder(): string {
    const value = this.buffer;
    this.buffer = "";
    return value;
  }
  get pending(): number {
    return this.buffer.length;
  }
}
export interface RemoteProvider {
  protocol: "vnc" | "rdp";
  parameters: Record<string, string>;
}
export function remoteProvider(machine: MachineConfig): RemoteProvider {
  const r = machine.remote;
  if (!r) throw new HubError(503, "REMOTE_UNAVAILABLE", "Удалённый рабочий стол не настроен");
  const password = r.passwordSecret ? process.env[r.passwordSecret] : undefined;
  if (!password)
    throw new HubError(503, "REMOTE_UNAVAILABLE", "Не настроен доступ к рабочему столу");
  return {
    protocol: r.provider,
    parameters: {
      hostname: r.host,
      port: String(r.port),
      username: r.username ?? "",
      password,
      "read-only": "false",
      "disable-copy": "true",
      "disable-paste": "true",
      "enable-sftp": "false",
      "enable-audio": "false",
      "disable-display-resize": "true",
      "color-depth": "24",
      cursor: "local",
      autoretry: "0",
      security: "nla",
      "ignore-cert": "false",
      "quality-level": "6",
      "compress-level": "6",
    },
  };
}
export function connectRemote(
  socket: WebSocket,
  provider: RemoteProvider,
  size: { width: number; height: number },
): () => void {
  const guacd = createConnection({ host: "127.0.0.1", port: 4822 });
  const decoder = new StringDecoder("utf8"),
    parser = new GuacParser(),
    inputParser = new GuacParser();
  let ready = false,
    closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    guacd.destroy();
    if (socket.readyState === 1) socket.close(1000, "Remote disconnected");
  };
  const fail = () => {
    if (socket.readyState === 1)
      socket.send(instruction("error", "Не удалось подключиться к рабочему столу", "519"));
    close();
  };
  const timer = setTimeout(fail, 15000);
  const send = (data: string) => {
    if (socket.readyState !== 1) return;
    if (socket.bufferedAmount > 4 * 1024 * 1024) {
      socket.close(1013, "Remote connection too slow");
      close();
      return;
    }
    socket.send(data);
  };
  guacd.once("connect", () => guacd.write(instruction("select", provider.protocol)));
  guacd.on("error", fail);
  guacd.on("close", close);
  guacd.on("data", (data) => {
    try {
      const decoded = decoder.write(data);
      // Emit complete instructions only. A tunnel keepalive must never be inserted
      // between two TCP fragments of a blob instruction.
      for (const parts of parser.feed(decoded)) {
        const opcode = parts[0];
        if (opcode === "args") {
          const names = parts.slice(1);
          const values = names.map((name) =>
            name.startsWith("VERSION_") ? "VERSION_1_5_0" : (provider.parameters[name] ?? ""),
          );
          guacd.write(
            instruction("size", String(size.width), String(size.height), "96") +
              instruction("audio") +
              instruction("video") +
              instruction("image", "image/png", "image/jpeg") +
              instruction("name", "Codex Web") +
              instruction("connect", ...values),
          );
        } else if (opcode === "ready") {
          ready = true;
          clearTimeout(timer);
          // Guacamole WebSocketTunnel reserves an empty opcode for its tunnel UUID.
          send(instruction("", randomUUID()));
        } else if (opcode === "error") {
          fail();
          return;
        } else if (ready) send(instruction(...parts));
      }
    } catch {
      fail();
    }
  });
  socket.on("message", (data, isBinary) => {
    if (closed || socket.readyState !== 1) return;
    if (isBinary || !ready) {
      socket.close(1008, "Invalid remote input");
      close();
      return;
    }
    try {
      const raw = data.toString();
      for (const parts of inputParser.feed(raw)) {
        const opcode = parts[0] ?? "";
        if (opcode === "") {
          send(instruction(...parts));
          continue;
        } // Tunnel keepalive.
        if (!["sync", "mouse", "key", "size", "ack", "disconnect", "nop"].includes(opcode))
          throw new Error("Input type is disabled");
        if (opcode === "disconnect") {
          close();
          return;
        }
        if (guacd.writableLength > 65536) throw new Error("Input backpressure");
        guacd.write(instruction(...parts));
      }
    } catch {
      socket.close(1008, "Invalid remote input");
      close();
    }
  });
  socket.once("close", close);
  socket.on("error", close);
  return close;
}
