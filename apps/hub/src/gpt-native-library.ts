import { HubError } from "@codex-web/shared";
import type { NativeGptWorkspace } from "./gpt-native-provider.js";
import type { EntityAction, EntityKind, Library } from "./library.js";
import type { Store } from "./store.js";

/** Hub intent is bound to this provider; the supervisor owns at-most-once effects. */
export class NativeGptLibrary {
  constructor(
    private store: Store,
    private workspace: NativeGptWorkspace,
    private library: Library,
  ) {
    store.db.exec(
      "CREATE TABLE IF NOT EXISTS gpt_native_library(key TEXT PRIMARY KEY, kind TEXT NOT NULL, id TEXT NOT NULL, input TEXT NOT NULL, state TEXT NOT NULL)",
    );
  }
  blocked() {
    return !!this.store.db
      .prepare("SELECT 1 FROM gpt_native_library WHERE state='unknown' LIMIT 1")
      .get();
  }
  pending(kind: EntityKind, id: string) {
    const row = this.store.db
      .prepare(
        "SELECT key,input FROM gpt_native_library WHERE kind=? AND id=? AND state='unknown' LIMIT 1",
      )
      .get(kind, id);
    return row
      ? { key: String(row.key), action: JSON.parse(String(row.input)) as EntityAction }
      : null;
  }
  async run(key: string, kind: EntityKind, id: string, action: EntityAction) {
    const input = JSON.stringify(action),
      db = this.store.db;
    const old = db.prepare("SELECT * FROM gpt_native_library WHERE key=?").get(key);
    if (old && (old.kind !== kind || old.id !== id || old.input !== input))
      throw new HubError(409, "IDEMPOTENCY_CONFLICT", "Ключ уже использован для другого действия.");
    if (old?.state === "completed") return { ok: true };
    if (old?.state === "rejected")
      throw new HubError(
        409,
        "GPT_ACTION_REJECTED",
        "ChatGPT не применил действие. Можно попробовать снова.",
      );
    if (!old) {
      if (this.blocked())
        throw new HubError(
          409,
          "GPT_LIBRARY_PENDING",
          "Сначала проверь результат предыдущего действия в его меню.",
        );
      this.library.assertExists(kind, id);
      db.prepare("INSERT INTO gpt_native_library VALUES(?,?,?,?,'unknown')").run(
        key,
        kind,
        id,
        input,
      );
    }
    let result: Awaited<ReturnType<NativeGptWorkspace["client"]["libraryMutation"]>>;
    try {
      result = await this.workspace.client.libraryMutation({ key, kind, id, ...action }, !!old);
    } catch (e) {
      if (
        !old &&
        e instanceof Error &&
        [
          "NATIVE_INVALID_CANARY",
          "NATIVE_INVALID_LIBRARY",
          "NATIVE_LIBRARY_NOT_WRITABLE",
          "NATIVE_PENDING_DISPATCH",
          "NATIVE_BUSY",
          "NATIVE_MANUAL_RECOVERY",
        ].includes(e.message)
      ) {
        db.prepare("UPDATE gpt_native_library SET state='rejected' WHERE key=?").run(key);
        throw new HubError(
          409,
          "GPT_ACTION_REJECTED",
          "Действие не началось: клиент занят, открыт вручную или объект пока недоступен новому подключению.",
        );
      }
      throw new HubError(
        409,
        "GPT_LIBRARY_UNKNOWN",
        "Связь прервалась. Проверь результат действия; повторная команда не отправится.",
      );
    }
    if (result.state === "unknown")
      throw new HubError(
        409,
        "GPT_LIBRARY_UNKNOWN",
        "ChatGPT ещё не подтвердил изменение. Проверь результат действия; повторная команда не отправится.",
      );
    if (result.state === "rejected") {
      db.prepare("UPDATE gpt_native_library SET state='rejected' WHERE key=?").run(key);
      throw new HubError(
        409,
        "GPT_ACTION_REJECTED",
        "ChatGPT не применил действие. Проверь доступ и отсутствие черновика в клиенте.",
      );
    }
    // Keep jobs/send receipts on delete: they prove prior effects and cannot be replayed.
    db.exec("BEGIN IMMEDIATE");
    try {
      this.library.save(kind, id, {
        name: action.action === "rename" ? action.name : result.name,
        projectId: result.projectId ?? undefined,
        changedAt: Date.now(),
        ...(action.action === "rename" ? { renamed: true, nameCheckedAt: Date.now() } : {}),
        ...(action.action === "archive" ? { archived: action.value } : {}),
        ...(action.action === "delete" ? { deleted: true, archived: false } : {}),
      });
      if (kind === "project" && action.action === "delete")
        for (const child of this.library
          .all()
          .filter((x) => x.kind === "thread" && x.projectId === id))
          this.library.save("thread", child.id, { deleted: true, archived: false, name: "" });
      db.prepare("UPDATE gpt_native_library SET state='completed' WHERE key=?").run(key);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    return { ok: true };
  }
}
