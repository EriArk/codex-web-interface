import { createHash } from "node:crypto";
import type { GptNativeProject, GptProjectOperation } from "@codex-web/shared";
import { HubError } from "@codex-web/shared";
import { z } from "zod";
import type { Store } from "./store.js";

const projectId = z.string().regex(/^g-p-[a-zA-Z0-9-]{1,80}$/);
const fileId = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const base = z.object({ projectId, revision });
export const gptProjectInput = z.discriminatedUnion("action", [
  base.extend({ action: z.literal("instructions"), text: z.string().max(100000) }).strict(),
  base.extend({ action: z.literal("upload"), uploadId: z.string().uuid() }).strict(),
  base.extend({ action: z.literal("remove"), fileId, confirm: z.literal(true) }).strict(),
]);
const projectSchema = z.object({
  id: projectId,
  name: z.string().max(500),
  instructions: z.string().max(100000),
  revision,
  canWrite: z.boolean(),
  files: z
    .array(
      z.object({
        id: fileId,
        name: z.string().max(500),
        bytes: z.number().int().nonnegative().nullable(),
      }),
    )
    .max(500),
});
export type GptProjectInput = z.infer<typeof gptProjectInput>;
type Input = GptProjectInput;
export interface NativeProjectTransport {
  read(id: string): Promise<GptNativeProject>;
  execute(key: string, input: Input): Promise<{ state: "completed" | "unknown" | "rejected" }>;
  check(key: string, id: string): Promise<{ state: "completed" | "unknown" | "rejected" }>;
}
type Row = GptProjectOperation & { fingerprint: string; input: string; baseline: string | null };
const fail = (code: string, text: string) => new HubError(409, code, text);
export class GptProjectContent {
  private work = Promise.resolve();
  private runningId: string | null = null;
  constructor(
    private store: Store,
    private json: (path: string, body?: unknown) => Promise<any>,
    private canStart: () => boolean,
    private file: (id: string) => { id: string; name: string; bytes: number; base64?: string },
    private signal: AbortSignal,
    private native?: NativeProjectTransport,
  ) {
    store.db.exec(
      "CREATE TABLE IF NOT EXISTS gpt_project_operation_providers(id TEXT PRIMARY KEY REFERENCES gpt_project_operations(id),provider TEXT NOT NULL)",
    );
    store.db.exec(
      "INSERT OR IGNORE INTO gpt_project_operation_providers SELECT id,'browser' FROM gpt_project_operations",
    );
    store.db
      .prepare(
        "UPDATE gpt_project_operations SET state='unknown',error='Подтверждение потеряно. Проверь проект.' WHERE state='pending'",
      )
      .run();
  }
  capabilities() {
    return { manualReview: !this.native, download: true };
  }
  blocked() {
    return (
      !!this.runningId ||
      !!this.store.db
        .prepare(
          "SELECT 1 FROM gpt_project_operations WHERE state IN ('pending','unknown') LIMIT 1",
        )
        .get()
    );
  }
  counts() {
    const r = this.store.db
      .prepare(
        "SELECT COALESCE(SUM(state='pending'),0) active,COALESCE(SUM(state='unknown'),0) unknown FROM gpt_project_operations",
      )
      .get()!;
    return { active: Number(r.active), unknown: Number(r.unknown) };
  }
  list(id: string) {
    const items = this.store.db
      .prepare(
        "SELECT id,projectId,action,state,error,createdAt FROM gpt_project_operations WHERE projectId=? ORDER BY createdAt DESC LIMIT 10",
      )
      .all(id) as GptProjectOperation[];
    return items.map((item) =>
      item.id === this.runningId && item.state === "unknown"
        ? { ...item, state: "pending" as const }
        : item,
    );
  }
  async read(id: string): Promise<GptNativeProject> {
    if (this.native) return projectSchema.parse(await this.native.read(projectId.parse(id)));
    return projectSchema.parse(
      await this.json("/project-content?id=" + encodeURIComponent(projectId.parse(id))),
    );
  }
  private row(id: string) {
    const row = this.store.db.prepare("SELECT * FROM gpt_project_operations WHERE id=?").get(id) as
      | Row
      | undefined;
    if (!row) throw new HubError(404, "GPT_PROJECT_OPERATION_MISSING", "Действие не найдено.");
    return row;
  }
  private assertProvider(id: string) {
    const provider =
      this.store.db
        .prepare("SELECT provider FROM gpt_project_operation_providers WHERE id=?")
        .get(id)?.provider ?? "browser";
    if (provider !== (this.native ? "native" : "browser"))
      throw fail(
        "GPT_OTHER_PROVIDER",
        "Это действие относится к прежнему подключению. Проверь его там.",
      );
  }
  private set(id: string, state: GptProjectOperation["state"], error = "") {
    this.store.db
      .prepare("UPDATE gpt_project_operations SET state=?,error=? WHERE id=?")
      .run(state, error, id);
  }
  start(id: string, input: Input) {
    const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex"),
      old = this.store.db
        .prepare("SELECT fingerprint FROM gpt_project_operations WHERE id=?")
        .get(id);
    if (old) {
      this.assertProvider(id);
      if (old.fingerprint !== fingerprint)
        throw fail("IDEMPOTENCY_CONFLICT", "Это действие уже сохранено с другими данными.");
      return { id };
    }
    if (!this.canStart() || this.blocked())
      throw fail("GPT_BUSY", "Сначала заверши или проверь текущее действие GPT.");
    if (input.action === "upload") this.file(input.uploadId);
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      this.store.db
        .prepare("INSERT INTO gpt_project_operations VALUES(?,?,?,'pending','',?,?,?,NULL)")
        .run(id, input.projectId, input.action, Date.now(), fingerprint, JSON.stringify(input));
      this.store.db
        .prepare("INSERT INTO gpt_project_operation_providers VALUES(?,?)")
        .run(id, this.native ? "native" : "browser");
      this.store.db.exec("COMMIT");
    } catch (e) {
      this.store.db.exec("ROLLBACK");
      throw e;
    }
    this.runningId = id;
    this.work = this.run(id, input);
    return { id };
  }
  private async run(id: string, input: Input) {
    let dispatched = false;
    try {
      if (!this.native) {
        const active = await this.json("/active");
        if (active.generating || active.requestId) throw fail("GPT_BUSY", "ChatGPT сейчас занят.");
      }
      const before = await this.read(input.projectId);
      if (!before.canWrite || before.revision !== input.revision)
        throw fail(
          "GPT_PROJECT_CHANGED",
          "Проект изменился. Обнови его перед сохранением; твой текст сохранён.",
        );
      const file = input.action === "upload" ? this.file(input.uploadId) : undefined;
      const baseline = { before, file: file ? { name: file.name, bytes: file.bytes } : null };
      this.store.db
        .prepare("UPDATE gpt_project_operations SET baseline=? WHERE id=?")
        .run(JSON.stringify(baseline), id);
      // Commit uncertainty before the connector can change native state. No mutation replay.
      this.set(id, "unknown", "Проверяем подтверждение ChatGPT.");
      dispatched = true;
      if (this.native) {
        const result = await this.native.execute(id, input);
        this.set(
          id,
          result.state === "rejected" ? "failed" : result.state,
          result.state === "unknown"
            ? "Проверяем подтверждение ChatGPT; повторной загрузки не будет."
            : result.state === "rejected"
              ? "Проект изменился или действие отклонено. Обнови данные и попробуй снова."
              : "",
        );
        return;
      }
      const result = await this.json("/project-content", { ...input, ...(file ? { file } : {}) });
      if (result.dispatched === false) {
        dispatched = false;
        throw fail(
          "GPT_PROJECT_NOT_SENT",
          "ChatGPT не применил действие. Обнови проект и попробуй снова.",
        );
      }
      this.set(id, "pending");
      const end = Date.now() + 60000;
      while (!this.signal.aborted && Date.now() < end) {
        if (await this.check(id, true)) return;
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            this.signal.removeEventListener("abort", done);
            resolve();
          };
          const timer = setTimeout(done, 1200);
          this.signal.addEventListener("abort", done, { once: true });
        });
      }
      this.set(
        id,
        "unknown",
        "ChatGPT пока не подтвердил результат. Проверь проект; действие не повторится.",
      );
    } catch (e) {
      this.set(
        id,
        dispatched ? "unknown" : "failed",
        dispatched
          ? "Подтверждение потеряно. Проверка прочитает проект без повторного действия."
          : e instanceof HubError
            ? e.message
            : "Действие не отправлено. Данные сохранены.",
      );
    } finally {
      this.runningId = null;
    }
  }
  async check(id: string, worker = false) {
    if (this.runningId === id && !worker) return false;
    const row = this.row(id);
    this.assertProvider(id);
    if (this.native && ["pending", "unknown"].includes(row.state)) {
      const result = await this.native.check(id, row.projectId);
      if (result.state === "completed") this.set(id, "completed");
      else if (result.state === "rejected") this.set(id, "failed", "ChatGPT не применил действие.");
      return result.state === "completed";
    }
    if (row.state === "completed") return true;
    if (!["pending", "unknown"].includes(row.state) || !row.baseline) return false;
    const input = JSON.parse(row.input) as Input,
      base = JSON.parse(row.baseline),
      current = await this.read(row.projectId);
    const confirmed =
      input.action === "instructions"
        ? current.instructions === input.text
        : input.action === "remove"
          ? !current.files.some((f) => f.id === input.fileId)
          : current.files.filter(
              (f) =>
                !base.before.files.some((b: { id: string }) => b.id === f.id) &&
                f.name === base.file.name &&
                f.bytes === base.file.bytes,
            ).length === 1;
    if (confirmed) this.set(id, "completed");
    return confirmed;
  }
  async checked(id: string) {
    if (this.runningId === id) throw fail("GPT_PROJECT_PENDING", "Действие ещё выполняется.");
    if (await this.check(id)) return;
    const row = this.row(id);
    if (this.native)
      throw fail(
        "GPT_NATIVE_RECONCILE",
        "Новый клиент ещё не подтвердил результат. Нельзя сбросить неизвестную загрузку и повторить её.",
      );
    if (row.state !== "unknown") throw fail("GPT_PROJECT_PENDING", "Действие ещё выполняется.");
    const active = await this.json("/active");
    if (active.generating || active.requestId) throw fail("GPT_BUSY", "ChatGPT сейчас занят.");
    this.set(id, "checked");
  }
  async close() {
    await this.work;
  }
}
