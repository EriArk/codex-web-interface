import { randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

export class SchemaError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export interface Migration {
  version: number;
  name: string;
  up: (db: DatabaseSync) => void;
}

export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: "initial-hub-state",
    up(db) {
      db.exec(
        "CREATE TABLE IF NOT EXISTS users(username TEXT PRIMARY KEY,passwordHash TEXT NOT NULL);\nCREATE TABLE IF NOT EXISTS bootstrap(id INTEGER PRIMARY KEY CHECK(id=1),tokenHash TEXT NOT NULL);\nCREATE TABLE IF NOT EXISTS sessions(tokenHash TEXT PRIMARY KEY,csrf TEXT NOT NULL,expires INTEGER NOT NULL);\nCREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires);\nCREATE TABLE IF NOT EXISTS threads(id TEXT PRIMARY KEY,projectId TEXT NOT NULL,codexThreadId TEXT UNIQUE NOT NULL,title TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'idle',activeTurnId TEXT,createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL);\nCREATE INDEX IF NOT EXISTS threads_project ON threads(projectId,updatedAt);\nCREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,threadId TEXT NOT NULL REFERENCES threads(id),turnId TEXT,type TEXT NOT NULL,payload TEXT NOT NULL,createdAt TEXT NOT NULL);\nCREATE INDEX IF NOT EXISTS events_thread ON events(threadId,seq);\nCREATE TABLE IF NOT EXISTS messages(threadId TEXT NOT NULL REFERENCES threads(id),id TEXT NOT NULL,turnId TEXT,role TEXT NOT NULL,phase TEXT NOT NULL,text TEXT NOT NULL,firstSeq INTEGER NOT NULL,lastSeq INTEGER NOT NULL,createdAt TEXT NOT NULL,PRIMARY KEY(threadId,id));\nCREATE INDEX IF NOT EXISTS messages_page ON messages(threadId,firstSeq DESC);\nCREATE TABLE IF NOT EXISTS results(id TEXT PRIMARY KEY,threadId TEXT NOT NULL REFERENCES threads(id),turnId TEXT,sourceKey TEXT NOT NULL,type TEXT NOT NULL,title TEXT NOT NULL,payload TEXT NOT NULL,createdAt TEXT NOT NULL,UNIQUE(threadId,sourceKey));\nCREATE TABLE IF NOT EXISTS commands(scope TEXT NOT NULL,key TEXT NOT NULL,digest TEXT NOT NULL,state TEXT NOT NULL,response TEXT,createdAt TEXT NOT NULL,PRIMARY KEY(scope,key));\nCREATE TABLE IF NOT EXISTS preferences(id INTEGER PRIMARY KEY CHECK(id=1),value TEXT NOT NULL);\nCREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY,threadId TEXT NOT NULL REFERENCES threads(id),mime TEXT NOT NULL,bytes INTEGER NOT NULL,createdAt TEXT NOT NULL);\nCREATE TABLE IF NOT EXISTS thread_settings(threadId TEXT PRIMARY KEY REFERENCES threads(id),value TEXT NOT NULL);\nCREATE TABLE IF NOT EXISTS attachments(id TEXT PRIMARY KEY,threadId TEXT NOT NULL REFERENCES threads(id),name TEXT NOT NULL,mime TEXT NOT NULL,bytes INTEGER NOT NULL,image INTEGER NOT NULL,messageId TEXT,createdAt TEXT NOT NULL);\nCREATE INDEX IF NOT EXISTS attachments_message ON attachments(threadId,messageId);",
      );
    },
  },
  {
    version: 2,
    name: "native-catalog-and-thread-metadata",
    up(db) {
      // Deployed prototype databases recorded version 1 but may already have these columns.
      // This compatibility bridge runs exactly once inside the ordered migration transaction.
      const columns = new Set(
        db
          .prepare("PRAGMA table_info(threads)")
          .all()
          .map((row) => row.name),
      );
      for (const [name, definition] of [
        ["origin", "TEXT NOT NULL DEFAULT 'web'"],
        ["workingDirectory", "TEXT"],
        ["historyMode", "TEXT"],
        ["sourceUpdatedAt", "INTEGER"],
        ["archived", "INTEGER NOT NULL DEFAULT 0"],
      ])
        if (!columns.has(name)) db.exec(`ALTER TABLE threads ADD COLUMN ${name} ${definition}`);
      db.exec(
        "CREATE TABLE IF NOT EXISTS catalog_projects(id TEXT PRIMARY KEY,machineId TEXT NOT NULL,sourceId TEXT NOT NULL,value TEXT NOT NULL,UNIQUE(machineId,sourceId)); CREATE TABLE IF NOT EXISTS history_cursors(id TEXT PRIMARY KEY,threadId TEXT NOT NULL,value TEXT NOT NULL,createdAt INTEGER NOT NULL)",
      );
    },
  },
  {
    version: 3,
    name: "thread-activity-and-seen-completions",
    up(db) {
      // Existing history starts read; only newly observed completed turns create badges.
      db.exec(
        "ALTER TABLE threads ADD COLUMN activityAt TEXT; ALTER TABLE threads ADD COLUMN completedSeq INTEGER NOT NULL DEFAULT 0; ALTER TABLE threads ADD COLUMN seenSeq INTEGER NOT NULL DEFAULT 0; ALTER TABLE threads ADD COLUMN completedTurnId TEXT; ALTER TABLE threads ADD COLUMN completedStatus TEXT;",
      );
    },
  },
  {
    version: 4,
    name: "external-activity-and-queue-recovery",
    up(db) {
      db.exec(
        "ALTER TABLE threads ADD COLUMN activitySource TEXT NOT NULL DEFAULT 'hub'; ALTER TABLE threads ADD COLUMN nativeObservedTurn TEXT; ALTER TABLE threads ADD COLUMN nativeObservedStatus TEXT; ALTER TABLE threads ADD COLUMN nativeObservedAt INTEGER; CREATE TABLE native_images(id TEXT PRIMARY KEY,threadId TEXT NOT NULL REFERENCES threads(id),messageId TEXT NOT NULL,sourceKey TEXT NOT NULL,source TEXT NOT NULL,name TEXT NOT NULL,artifactId TEXT REFERENCES artifacts(id),UNIQUE(threadId,messageId,sourceKey)); CREATE TABLE queue_transfers(threadId TEXT NOT NULL REFERENCES threads(id),id TEXT NOT NULL,value TEXT NOT NULL,state TEXT NOT NULL,PRIMARY KEY(threadId,id));",
      );
    },
  },
];
export const SCHEMA_VERSION = migrations.at(-1)?.version ?? 0;

export function schemaVersion(db: DatabaseSync): number {
  if (
    !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get()
  ) {
    if (
      db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .get()
    )
      throw new SchemaError(
        "DB_SCHEMA_UNVERSIONED",
        "Database has unrecognized tables without a schema version",
      );
    return 0;
  }
  const versions = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all();
  if (versions.some((row, index) => row.version !== index + 1))
    throw new SchemaError("DB_SCHEMA_INVALID", "Database migration history is not contiguous");
  return Number(versions.at(-1)?.version ?? 0);
}
export function migrateDatabase(
  db: DatabaseSync,
  path = ":memory:",
  sequence = migrations,
): number {
  if (sequence.some((m, i) => m.version !== i + 1))
    throw new SchemaError("MIGRATIONS_INVALID", "Application migration sequence is not contiguous");
  const current = schemaVersion(db),
    supported = sequence.at(-1)?.version ?? 0;
  if (current > supported)
    throw new SchemaError(
      "DB_SCHEMA_TOO_NEW",
      `Database schema ${current} is newer than supported schema ${supported}. Use the matching application or restore a pre-upgrade backup.`,
    );
  if (current === supported) return current;
  if (current > 0 && path !== ":memory:") {
    const directory = join(dirname(path), "migration-backups");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const info = lstatSync(directory);
    if (
      info.isSymbolicLink() ||
      !info.isDirectory() ||
      (process.platform !== "win32" && info.mode & 0o077)
    )
      throw new SchemaError(
        "BACKUP_DIRECTORY_UNSAFE",
        "Migration backup directory must be private",
      );
    const checkpoint = join(directory, `before-schema-${current}-${randomUUID()}.db`);
    db.prepare("VACUUM INTO ?").run(checkpoint);
    chmodSync(checkpoint, 0o600);
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    // Another process may have migrated while this connection made its backup.
    const lockedVersion = schemaVersion(db);
    if (lockedVersion > supported)
      throw new SchemaError("DB_SCHEMA_TOO_NEW", "Database was upgraded by a newer application");
    db.exec("CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY)");
    for (const migration of sequence)
      if (migration.version > lockedVersion) {
        migration.up(db);
        db.prepare("INSERT INTO schema_migrations(version) VALUES(?)").run(migration.version);
      }
    db.exec("COMMIT");
    return supported;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
