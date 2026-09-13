import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { HubError, type SharedAsset } from "@codex-web/shared";
import type { TeamStore } from "./team-store.js";

const missing = () => new HubError(404, "SHARED_FILE_MISSING", "Файл недоступен.");
export const sharedAssetPath = (root: string, id: string) => {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw missing();
  return join(root, id + ".bin");
};
export function readSharedFile(root: string, value: Pick<SharedAsset, "id" | "bytes" | "sha256">) {
  const path = sharedAssetPath(root, value.id),
    info = lstatSync(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    realpathSync(path) !== resolve(path) ||
    info.size !== value.bytes ||
    info.size > 32 * 1024 * 1024
  )
    throw new HubError(409, "SHARED_FILE_CHANGED", "Сохранённый файл не прошёл проверку.");
  const data = readFileSync(path);
  if (createHash("sha256").update(data).digest("hex") !== value.sha256)
    throw new HubError(409, "SHARED_FILE_CHANGED", "Сохранённый файл не прошёл проверку.");
  return data;
}
/** Immutable, explicitly selected copies; there are no bearer download capabilities. */
export class TeamAssets {
  readonly root: string;
  constructor(
    readonly registry: TeamStore,
    private access: (actor: string, projectId: string) => unknown,
  ) {
    this.root = join(dirname(registry.path), "shared-results");
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    if (
      realpathSync(this.root) !== resolve(this.root) ||
      !lstatSync(this.root).isDirectory() ||
      lstatSync(this.root).isSymbolicLink()
    )
      throw Error("TEAM_SHARED_STORAGE_UNSAFE");
  }
  private get db() {
    return this.registry.db;
  }
  private metadata(row: Record<string, unknown>): SharedAsset {
    return {
      id: String(row.id),
      name: String(row.name),
      mime: String(row.mime),
      bytes: Number(row.bytes),
      sha256: String(row.sha256),
    };
  }
  stage(
    actor: string,
    projectId: string,
    source: string,
    name: string,
    mime: string,
    data: Buffer,
  ) {
    this.access(actor, projectId);
    if (data.length > 32 * 1024 * 1024)
      throw new HubError(413, "SHARED_FILE_TOO_LARGE", "Файл больше 32 МБ.");
    const sha256 = createHash("sha256").update(data).digest("hex");
    const existing = this.db
      .prepare(
        "SELECT * FROM team_assets WHERE projectId=? AND ownerId=? AND source=? AND sha256=?",
      )
      .get(projectId, actor, source, sha256);
    if (existing) {
      readSharedFile(this.root, this.metadata(existing));
      return this.metadata(existing);
    }
    if (
      Number(this.db.prepare("SELECT COALESCE(sum(bytes),0) n FROM team_assets").get()?.n) +
        data.length >
      1024 ** 3
    )
      throw new HubError(
        507,
        "SHARED_STORAGE_FULL",
        "Общее хранилище заполнено (1 ГБ). Сохранённые файлы доступны.",
      );
    const id = randomUUID();
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Remove filename controls before display/download headers.
    const safeName = name.replace(/[\u0000-\u001f\u007f/\\]/g, "_").slice(0, 180) || "Файл";
    writeFileSync(sharedAssetPath(this.root, id), data, { flag: "wx", mode: 0o600 });
    this.db
      .prepare("INSERT INTO team_assets VALUES(?,?,?,?,?,?,?,?,?)")
      .run(
        id,
        projectId,
        actor,
        safeName,
        mime.slice(0, 120),
        data.length,
        sha256,
        source,
        Date.now(),
      );
    return { id, name: safeName, mime: mime.slice(0, 120), bytes: data.length, sha256 };
  }
  selected(actor: string, projectId: string, id: string, source?: string) {
    this.access(actor, projectId);
    const row = this.db
      .prepare("SELECT * FROM team_assets WHERE id=? AND projectId=? AND ownerId=?")
      .get(id, projectId, actor);
    if (!row || (source && row.source !== source)) throw missing();
    const file = this.metadata(row);
    readSharedFile(this.root, file);
    return file;
  }
  attach(actor: string, projectId: string, itemId: string, files: SharedAsset[]) {
    for (const file of files) {
      const actual = this.selected(actor, projectId, file.id);
      if (JSON.stringify(actual) !== JSON.stringify(file)) throw missing();
      this.db
        .prepare("INSERT OR IGNORE INTO team_material_assets VALUES(?,?)")
        .run(itemId, file.id);
    }
  }
  list(itemId: string) {
    return this.db
      .prepare(
        "SELECT a.* FROM team_assets a JOIN team_material_assets m ON m.assetId=a.id WHERE m.itemId=? ORDER BY a.name,a.id",
      )
      .all(itemId)
      .map((row) => this.metadata(row));
  }
  read(actor: string, projectId: string, id: string) {
    this.access(actor, projectId);
    const row = this.db
      .prepare(
        "SELECT a.* FROM team_assets a WHERE a.id=? AND a.projectId=? AND (a.ownerId=? OR EXISTS(SELECT 1 FROM team_material_assets x JOIN team_materials m ON m.id=x.itemId WHERE x.assetId=a.id AND m.projectId=a.projectId AND m.deleted=0))",
      )
      .get(id, projectId, actor);
    if (!row) throw missing();
    const file = this.metadata(row);
    return { file, data: readSharedFile(this.root, file) };
  }
}
