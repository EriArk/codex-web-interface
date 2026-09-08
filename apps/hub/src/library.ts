import { HubError, NotSubmittedError } from "@codex-web/shared";
import { z } from "zod";
import type { Store } from "./store.js";

export const entityAction = z.discriminatedUnion("action", [
  z.object({ action: z.literal("pin"), value: z.boolean() }).strict(),
  z.object({ action: z.literal("rename"), name: z.string().trim().min(1).max(120) }).strict(),
  z.object({ action: z.literal("archive"), value: z.boolean() }).strict(),
  z.object({ action: z.literal("delete"), confirm: z.literal(true) }).strict(),
]);
export type EntityAction = z.infer<typeof entityAction>;
export type EntityKind = "project" | "thread";
export type LibraryEntry = {
  id: string;
  kind: EntityKind;
  name: string;
  projectId?: string;
  localId?: string;
  localArchive?: boolean;
  renamed?: boolean;
  nameCheckedAt?: number;
  changedAt?: number;
  pinned?: boolean;
  archived?: boolean;
  deleted?: boolean;
};
export class Library {
  constructor(
    readonly store: Store,
    readonly client: "codex" | "gpt",
  ) {}
  get(kind: EntityKind, id: string): LibraryEntry | undefined {
    const row = this.store.db
      .prepare("SELECT value FROM library_entities WHERE client=? AND kind=? AND id=?")
      .get(this.client, kind, id);
    return row ? JSON.parse(String(row.value)) : undefined;
  }
  all(): LibraryEntry[] {
    return this.store.db
      .prepare("SELECT value FROM library_entities WHERE client=?")
      .all(this.client)
      .map((row) => JSON.parse(String(row.value)));
  }
  save(kind: EntityKind, id: string, patch: Partial<LibraryEntry>) {
    const value = { ...this.get(kind, id), ...patch, id, kind };
    this.store.db
      .prepare(
        "INSERT INTO library_entities(client,kind,id,value) VALUES(?,?,?,?) ON CONFLICT(client,kind,id) DO UPDATE SET value=excluded.value",
      )
      .run(this.client, kind, id, JSON.stringify(value));
    this.store.changes.emit("navigation");
    return value;
  }
  assertExists(kind: EntityKind, id: string) {
    if (this.get(kind, id)?.deleted)
      throw new HubError(404, "ENTITY_DELETED", "Этот объект уже удалён.");
  }
  archived() {
    return this.all().filter((row) => row.archived && !row.deleted);
  }
}

// These rejections occur before an effect, or explicitly confirm that the native service refused it.
export async function libraryMutation<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (
      error instanceof HubError &&
      [
        "ENTITY_BUSY",
        "ENTITY_QUEUED",
        "GPT_BUSY",
        "GPT_LIBRARY_BUSY",
        "GPT_PIN_LIMIT",
        "GPT_ACTION_REJECTED",
        "HANDOFF_PENDING",
        "MACHINE_RELEASED",
        "PROJECT_BUSY",
        "NATIVE_PROJECT_REQUIRED",
        "CODEX_METHOD_UNSUPPORTED",
        "THREAD_NOT_LOADED",
        "THREAD_NOT_PERSISTED",
        "THREAD_ARCHIVED",
      ].includes(error.code)
    )
      throw new NotSubmittedError(error);
    throw error;
  }
}
