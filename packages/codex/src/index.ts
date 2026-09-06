import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { StringDecoder } from "node:string_decoder";
import { stopProcess } from "@codex-web/machines";
import { HubError } from "@codex-web/shared";

type RpcId = string | number;
type RecordValue = Record<string, unknown>;
export interface ServerRequest {
  id: RpcId;
  method: string;
  params: RecordValue;
}
export class CodexClient extends EventEmitter {
  private nextId = 1;
  private buffer = "";
  private decoder = new StringDecoder("utf8");
  private pending = new Map<
    number,
    { resolve: (v: RecordValue) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  private ended = false;
  constructor(
    private child: ChildProcessWithoutNullStreams,
    private timeoutMs = 30000,
    private maxMessageBytes = 16 * 1024 * 1024,
  ) {
    super();
    child.stdout.on("data", (chunk: Buffer) => this.receive(chunk));
    child.stderr.on("data", () => {}); // Raw stderr may contain private environment/source information.
    child.once("error", () =>
      this.fail(
        new HubError(503, "CODEX_START_FAILED", "Cannot launch Codex on the target machine"),
      ),
    );
    child.once("close", () =>
      this.fail(new HubError(503, "CODEX_DISCONNECTED", "Connection to Codex closed")),
    );
    child.stdin.on("error", () =>
      this.fail(new HubError(503, "CODEX_WRITE_FAILED", "Cannot send a request to Codex")),
    );
  }
  get closed(): boolean {
    return this.ended;
  }
  async initialize(): Promise<RecordValue> {
    const result = await this.request("initialize", {
      clientInfo: { name: "codex_web_interface", title: "Codex Web Interface", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized", {});
    return result;
  }
  request(method: string, params: RecordValue): Promise<RecordValue> {
    if (this.ended)
      return Promise.reject(new HubError(503, "CODEX_DISCONNECTED", "Codex connection is closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new HubError(
            504,
            "CODEX_REQUEST_TIMEOUT",
            "Codex did not acknowledge the request; its outcome may be unknown",
          ),
        );
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, method, params });
    });
  }
  notify(method: string, params: RecordValue): void {
    this.write({ method, params });
  }
  respond(id: RpcId, result: RecordValue): void {
    this.write({ id, result });
  }
  rejectRequest(id: RpcId): void {
    this.write({
      id,
      error: { code: -32601, message: "This client does not support this request" },
    });
  }
  close(): void {
    this.fail(new HubError(503, "CODEX_CLOSED", "Codex session closed"));
  }
  private write(value: RecordValue): void {
    if (this.ended) throw new HubError(503, "CODEX_DISCONNECTED", "Codex connection is closed");
    try {
      this.child.stdin.write(`${JSON.stringify(value)}\n`);
    } catch {
      this.fail(new HubError(503, "CODEX_WRITE_FAILED", "Cannot send a request to Codex"));
    }
  }
  private receive(chunk: Buffer): void {
    if (this.ended) return;
    this.buffer += this.decoder.write(chunk);
    for (;;) {
      const end = this.buffer.indexOf("\n");
      if (end < 0) break;
      const line = this.buffer.slice(0, end).trim();
      this.buffer = this.buffer.slice(end + 1);
      if (!line) continue;
      if (Buffer.byteLength(line) > this.maxMessageBytes) {
        this.invalid();
        return;
      }
      let data: unknown;
      try {
        data = JSON.parse(line);
      } catch {
        this.invalid();
        return;
      }
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        this.invalid();
        return;
      }
      const value = data as RecordValue;
      if (typeof value.method === "string") {
        const params =
          value.params && typeof value.params === "object" && !Array.isArray(value.params)
            ? (value.params as RecordValue)
            : {};
        if (typeof value.id === "number" || typeof value.id === "string")
          this.emit("request", {
            id: value.id,
            method: value.method,
            params,
          } satisfies ServerRequest);
        else if (value.id === undefined) this.emit("notification", value.method, params);
        else {
          this.invalid();
          return;
        }
      } else if (typeof value.id === "number") {
        const entry = this.pending.get(value.id);
        if (!entry) continue; // A timed-out response must never trigger an automatic retry.
        this.pending.delete(value.id);
        clearTimeout(entry.timer);
        if (value.error) {
          const message =
            typeof (value.error as RecordValue).message === "string"
              ? String((value.error as RecordValue).message)
              : "";
          entry.reject(
            message.includes("already has an active writer")
              ? new HubError(
                  409,
                  "THREAD_IN_USE",
                  "Диалог занят другим клиентом Codex. Для перехода на веб полностью выйди из ChatGPT/Codex на Windows, включая значок в трее, когда его работа завершится. Фоновый CodexWeb Companion оставь включённым. Черновик сохранён.",
                )
              : new HubError(
                  502,
                  "CODEX_RPC_ERROR",
                  "Codex отклонил запрос. Сообщение не подтверждено; проверь состояние диалога.",
                ),
          );
        } else if (value.result && typeof value.result === "object" && !Array.isArray(value.result))
          entry.resolve(value.result as RecordValue);
        else
          entry.reject(
            new HubError(502, "INVALID_CODEX_RESPONSE", "Codex returned an invalid response"),
          );
      } else {
        this.invalid();
        return;
      }
    }
    if (Buffer.byteLength(this.buffer) > this.maxMessageBytes) this.invalid();
  }
  private invalid(): void {
    this.fail(
      new HubError(
        502,
        "INVALID_CODEX_PROTOCOL",
        "Codex sent malformed or oversized protocol data",
      ),
    );
  }
  private fail(error: HubError): void {
    if (this.ended) return;
    this.ended = true;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
    stopProcess(this.child);
    this.emit("fault", error);
  }
}
