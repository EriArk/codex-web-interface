import { createHash } from "node:crypto";
import { codexArtifactPath, copyCodexArtifact, type readProjectFile } from "@codex-web/machines";
import { CHAT_BLOCK_LINES, textBlockLines, HubError, type MachineConfig } from "@codex-web/shared";
import { gptResultContent } from "./gpt-result-content.js";
import type { Artifacts } from "./artifacts.js";
import type { Store, ThreadRecord } from "./store.js";

const mimeTypes: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  html: "text/html",
  htm: "text/html",
  svg: "image/svg+xml",
  zip: "application/zip",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
const generatedTypes =
  /\.(?:png|jpe?g|webp|gif|svg|pdf|stl|step|stp|3mf|obj|glb|gltf|docx|xlsx|pptx)$/i;
const secretPath =
  /(?:^|[\\/])(?:\.[^\\/]+|node_modules|credentials?[^\\/]*|secrets?[^\\/]*|auth\.json|id_rsa|id_ed25519|[^\\/]*\.(?:pem|key|p12|pfx))(?:[\\/]|$)/i;
const text = (v: unknown) => (typeof v === "string" ? v : "");
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};
export function artifactSources(item: Record<string, unknown>): string[] {
  const paths: string[] = [];
  if (item.type === "agentMessage") {
    // Explicit assistant file links. Embedded images already use the native image pipeline.
    for (const match of text(item.text).matchAll(
      /(?<!!)\[[^\]\n]{1,200}\]\((?:<([^>\n]+)>|([^\s)]+))\)/g,
    )) {
      const path = (match[1] || match[2] || "").replace(/:\d+(?::\d+)?$/, "");
      if (
        path &&
        !path.startsWith("#") &&
        !path.startsWith("/api/") &&
        !/^[a-z][a-z0-9+.-]*:/i.test(path.replace(/^[a-z]:[\\/]/i, ""))
      )
        paths.push(path);
    }
  } else if (item.type === "fileChange" && Array.isArray(item.changes)) {
    for (const c of item.changes) {
      const path = text(obj(c).path),
        kind = text(obj(obj(c).kind).type) || text(obj(c).kind);
      if (generatedTypes.test(path) && !["delete", "remove"].includes(kind)) paths.push(path);
    }
  }
  return [...new Set(paths)].filter((p) => !secretPath.test(p)).slice(0, 8);
}
type Capture = {
  id: string;
  threadId: string;
  turnId: string | null;
  path: string;
  name: string;
  status: string;
  artifactId: string | null;
};
export class GeneratedArtifacts {
  private pending = new Map<string, Promise<void>>();
  private serial: Promise<void> = Promise.resolve();
  constructor(
    private store: Store,
    private artifacts: Artifacts,
    private target: (threadId: string) => { machine: MachineConfig; root: string },
    private read?: typeof readProjectFile,
  ) {
    // A restart is not proof that bytes were captured. Keep an explicit retryable result.
    for (const row of store.db
      .prepare("SELECT * FROM artifact_captures WHERE status='capturing'")
      .all()) {
      store.db
        .prepare("UPDATE artifact_captures SET status='failed' WHERE id=?")
        .run(String(row.id));
      this.publish({ ...row, status: "failed" } as unknown as Capture);
    }
  }
  onChange: (threadId: string, resultId: string, turnId: string | null) => void = () => {};
  private publish(c: Capture, notify = true, failure?: string) {
    const file = c.artifactId
      ? this.store.db
          .prepare(
            "SELECT a.bytes,a.mime,f.sha256,a.createdAt FROM artifacts a JOIN artifact_files f ON f.id=a.id WHERE a.id=?",
          )
          .get(c.artifactId)
      : undefined;
    const payload = file
      ? {
          url: `/api/artifacts/${c.artifactId}`,
          bytes: file.bytes,
          mime: file.mime,
          sha256: file.sha256,
          capturedAt: file.createdAt,
        }
      : {
          captureId: c.id,
          status: c.status,
          message:
            c.status === "capturing"
              ? "Сохраняем файл…"
              : failure || "Файл не сохранён. Можно повторить загрузку текущей версии (до 512 МБ).",
        };
    const sourceKey = "artifact:" + c.id;
    const old = this.store.db
      .prepare("SELECT id FROM results WHERE threadId=? AND sourceKey=?")
      .get(c.threadId, sourceKey);
    const type =
      file &&
      Number(file.bytes) <= 32 * 1024 * 1024 &&
      /^image\/(png|jpeg|webp|gif)$/.test(String(file.mime))
        ? "image"
        : "artifact";
    const id = old
      ? String(old.id)
      : this.store.result(c.threadId, c.turnId, sourceKey, type, c.name, payload);
    if (old)
      this.store.db
        .prepare("UPDATE results SET type=?,payload=? WHERE id=?")
        .run(type, JSON.stringify(payload), String(old.id));
    if (id && notify) this.onChange(c.threadId, id, c.turnId);
  }
  observe(thread: ThreadRecord, turnId: string | null, item: Record<string, unknown>): void {
    if (item.type === "agentMessage" && item.phase !== "commentary") {
      for (const block of gptResultContent(text(item.text)).blocks) {
        if (textBlockLines(block.text) <= CHAT_BLOCK_LINES) continue;
        const key =
          "text-block:" +
          JSON.stringify([
            turnId,
            item.id,
            block.offset,
            createHash("sha256").update(block.text).digest("hex"),
          ]);
        if (
          this.store.db
            .prepare("SELECT 1 FROM results WHERE threadId=? AND sourceKey=?")
            .get(thread.id, key)
        )
          continue;
        try {
          const name = `block-${block.index + 1}.txt`;
          const file = this.artifacts.putFile(
            thread.id,
            turnId,
            name,
            key,
            "text/plain",
            Buffer.from(block.text),
          );
          const id = this.store.result(thread.id, turnId, key, "artifact", name, {
            ...file,
            language: block.language,
          });
          if (id) this.onChange(thread.id, id, turnId);
        } catch {
          // The canonical message remains available if artifact storage is full.
        }
      }
    }
    let target: { machine: MachineConfig; root: string };
    try {
      target = this.target(thread.id);
    } catch {
      return;
    }
    for (const source of artifactSources(item)) {
      let path: string;
      try {
        path = codexArtifactPath(target.machine, target.root, source);
      } catch {
        continue;
      }
      if (secretPath.test(path)) continue;
      const id = createHash("sha256")
        .update(JSON.stringify([thread.id, turnId, item.id, path]))
        .digest("hex");
      if (this.store.db.prepare("SELECT 1 FROM artifact_captures WHERE id=?").get(id)) continue;
      if (
        Number(this.store.db.prepare("SELECT count(*) n FROM artifact_captures").get()?.n) >= 5000
      )
        break;
      const name = path.split(/[\\/]/).at(-1)?.slice(0, 200) || "Файл";
      const capture: Capture = {
        id,
        threadId: thread.id,
        turnId,
        path,
        name,
        status: "failed",
        artifactId: null,
      };
      this.store.db
        .prepare("INSERT INTO artifact_captures VALUES(?,?,?,?,?,?,NULL)")
        .run(id, thread.id, turnId, path, name, "failed");
      this.publish(capture);
      if (this.pending.size < 16) void this.capture(id).catch(() => {});
    }
  }
  get(id: string): Capture {
    const row = this.store.db.prepare("SELECT * FROM artifact_captures WHERE id=?").get(id);
    if (!row) throw new HubError(404, "ARTIFACT_NOT_FOUND", "Файл не найден.");
    return row as unknown as Capture;
  }
  capture(id: string): Promise<void> {
    const c = this.get(id);
    if (c.status === "captured") return Promise.resolve();
    const pending = this.pending.get(id);
    if (pending) return pending;
    if (this.pending.size >= 16)
      throw new HubError(429, "ARTIFACT_BUSY", "Дождись сохранения других файлов.");
    c.status = "capturing";
    this.store.db.prepare("UPDATE artifact_captures SET status='capturing' WHERE id=?").run(id);
    this.publish(c);
    const task = this.serial
      .catch(() => {})
      .then(async () => {
        try {
          const target = this.target(c.threadId);
          const mime =
            mimeTypes[c.name.split(".").at(-1)?.toLowerCase() || ""] || "application/octet-stream";
          const file = this.read
            ? this.artifacts.putFile(
                c.threadId,
                c.turnId,
                c.name,
                c.path,
                mime,
                await this.read(target.machine, target.root, c.path),
              )
            : await this.artifacts.putStream(
                c.threadId,
                c.turnId,
                c.name,
                c.path,
                mime,
                (destination, limit) =>
                  copyCodexArtifact(target.machine, target.root, c.path, destination, limit),
              );
          this.store.db.exec("SAVEPOINT artifact_capture_commit");
          try {
            c.artifactId = file.artifactId;
            c.status = "captured";
            this.store.db
              .prepare("UPDATE artifact_captures SET status='captured',artifactId=? WHERE id=?")
              .run(file.artifactId, id);
            this.publish(c, false);
            this.store.db.exec("RELEASE artifact_capture_commit");
          } catch (error) {
            this.store.db.exec(
              "ROLLBACK TO artifact_capture_commit; RELEASE artifact_capture_commit",
            );
            throw error;
          }
        } catch (error) {
          c.artifactId = null;
          c.status = "failed";
          this.store.db.prepare("UPDATE artifact_captures SET status='failed' WHERE id=?").run(id);
          this.publish(c, true, error instanceof HubError ? error.message : undefined);
          return;
        }
        this.publish(c);
      })
      .finally(() => this.pending.delete(id));
    this.pending.set(id, task);
    this.serial = task;
    return task;
  }
  async close() {
    await this.serial.catch(() => {});
  }
}
