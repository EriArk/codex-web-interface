import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import type { BrainstormRooms } from "./brainstorm.js";

type Peer = {
  socket: WebSocket;
  user: string;
  id: number;
  muted: boolean;
  deafened: boolean;
  check: () => void;
  alive: boolean;
  epoch: number;
  frames: number;
};
/** Small installation audio relay. No audio storage, credentials or PC network listeners. */
export class BrainstormVoice {
  private server = new WebSocketServer({
    noServer: true,
    maxPayload: 2048,
    perMessageDeflate: false,
  });
  private rooms = new Map<string, Set<Peer>>();
  private serial = 0;
  private timer: ReturnType<typeof setInterval>;
  constructor(private board: BrainstormRooms) {
    this.timer = setInterval(() => {
      for (const peers of this.rooms.values())
        for (const peer of peers) {
          try {
            peer.check();
            if (!peer.alive) throw Error();
            peer.alive = false;
            peer.socket.ping();
          } catch {
            peer.socket.terminate();
          }
        }
    }, 15000);
    this.timer.unref();
  }
  get active() {
    return [...this.rooms.values()].reduce((n, p) => n + p.size, 0);
  }
  upgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    room: string,
    user: string,
    check: () => void,
  ) {
    this.board.access(user, room, true);
    const peers = this.rooms.get(room) ?? new Set<Peer>();
    if (peers.size >= 8 || this.active >= 128) throw Error("ROOM_VOICE_FULL");
    this.server.handleUpgrade(req, socket, head, (ws) => {
      for (const p of peers) if (p.user === user) p.socket.close(1000, "replaced");
      const peer: Peer = {
        socket: ws,
        user,
        id: ++this.serial,
        muted: true,
        deafened: false,
        check: () => {
          check();
          this.board.access(user, room, true);
        },
        alive: true,
        epoch: Date.now(),
        frames: 0,
      };
      peers.add(peer);
      this.rooms.set(room, peers);
      const announce = () => {
        const list = [...peers].map((p) => ({
          id: p.id,
          name: this.board.team.registry.user(p.user).name,
          muted: p.muted,
          deafened: p.deafened,
        }));
        for (const p of peers)
          if (p.socket.readyState === WebSocket.OPEN)
            p.socket.send(JSON.stringify({ type: "peers", self: p.id, peers: list }));
      };
      ws.on("pong", () => {
        peer.alive = true;
      });
      ws.on("message", (raw, binary) => {
        try {
          const now = Date.now();
          if (now - peer.epoch >= 1000) {
            peer.check();
            peer.epoch = now;
            peer.frames = 0;
          }
          if (++peer.frames > 45) throw Error("RATE");
          if (binary) {
            if (!Buffer.isBuffer(raw) || raw.length !== 1280) throw Error("FRAME");
            if (peer.muted) return;
            const frame = Buffer.allocUnsafe(1284);
            frame.writeUInt32LE(peer.id, 0);
            raw.copy(frame, 4);
            for (const other of peers)
              if (other !== peer && !other.deafened && other.socket.readyState === WebSocket.OPEN) {
                if (other.socket.bufferedAmount > 128 * 1024) {
                  other.socket.close(1013, "slow");
                  continue;
                }
                other.socket.send(frame, { binary: true });
              }
          } else {
            const value = JSON.parse(raw.toString());
            if (
              value.type !== "state" ||
              typeof value.muted !== "boolean" ||
              typeof value.deafened !== "boolean"
            )
              throw Error("CONTROL");
            peer.muted = value.muted;
            peer.deafened = value.deafened;
            announce();
          }
        } catch {
          ws.close(1008, "invalid");
        }
      });
      ws.on("error", () => ws.terminate());
      ws.on("close", () => {
        peers.delete(peer);
        if (!peers.size) this.rooms.delete(room);
        else announce();
      });
      announce();
    });
  }
  close() {
    clearInterval(this.timer);
    for (const peers of this.rooms.values()) for (const p of peers) p.socket.terminate();
    this.server.close();
    this.rooms.clear();
  }
}
