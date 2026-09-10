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
  {
    version: 5,
    name: "chatgpt-outbox-and-interactive-previews",
    up(db) {
      db.exec(
        "CREATE TABLE IF NOT EXISTS gpt_jobs(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,nativeId TEXT,text TEXT NOT NULL,files TEXT NOT NULL,model TEXT NOT NULL,effort TEXT NOT NULL,status TEXT NOT NULL,answer TEXT NOT NULL,assets TEXT NOT NULL,createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL,error TEXT NOT NULL,requestId TEXT,submitted INTEGER NOT NULL DEFAULT 0);" +
          "CREATE TABLE IF NOT EXISTS gpt_uploads(id TEXT PRIMARY KEY,name TEXT NOT NULL,mime TEXT NOT NULL,bytes INTEGER NOT NULL,image INTEGER NOT NULL,createdAt INTEGER NOT NULL);",
      );
      db.exec(
        "CREATE TABLE IF NOT EXISTS html_previews(id TEXT PRIMARY KEY,threadId TEXT NOT NULL,source TEXT NOT NULL,createdAt TEXT NOT NULL)",
      );
    },
  },
  {
    version: 6,
    name: "chatgpt-visible-progress",
    up(db) {
      db.exec(
        "CREATE TABLE gpt_job_progress(jobId TEXT PRIMARY KEY REFERENCES gpt_jobs(id) ON DELETE CASCADE, value TEXT NOT NULL)",
      );
    },
  },
  {
    version: 7,
    name: "navigation-library",
    up(db) {
      db.exec(
        "CREATE TABLE library_entities(client TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(client,kind,id))",
      );
    },
  },
  {
    version: 8,
    name: "owner-credential-recovery",
    up(db) {
      db.exec(
        "CREATE TABLE auth_state(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL DEFAULT 0, recoveryHash TEXT, recoveryExpires INTEGER); INSERT INTO auth_state(id) VALUES(1)",
      );
    },
  },
  {
    version: 9,
    name: "storage-maintenance-receipts",
    up(db) {
      db.exec(
        "CREATE TABLE gpt_staged_uploads(jobId TEXT NOT NULL REFERENCES gpt_jobs(id) ON DELETE CASCADE,fileId TEXT NOT NULL,createdAt INTEGER NOT NULL,PRIMARY KEY(jobId,fileId)); CREATE INDEX events_compaction ON events(threadId,turnId,type,seq)",
      );
    },
  },
  {
    version: 10,
    name: "private-work-notifications",
    up(db) {
      db.exec(`
        CREATE TABLE push_subscriptions(id TEXT PRIMARY KEY,owner TEXT NOT NULL REFERENCES sessions(tokenHash) ON DELETE CASCADE,value TEXT NOT NULL,categories TEXT NOT NULL,createdAt INTEGER NOT NULL);
        CREATE TABLE push_notices(id TEXT PRIMARY KEY,eventKey TEXT NOT NULL UNIQUE,client TEXT NOT NULL,target TEXT NOT NULL,category TEXT NOT NULL,kind TEXT NOT NULL,createdAt INTEGER NOT NULL,fanned INTEGER NOT NULL DEFAULT 0);
        CREATE INDEX push_notice_age ON push_notices(createdAt);
        CREATE TABLE push_deliveries(notice TEXT NOT NULL REFERENCES push_notices(id) ON DELETE CASCADE,subscription TEXT NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,state TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,nextAt INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(notice,subscription));
        CREATE TRIGGER push_codex_event AFTER INSERT ON events
        WHEN EXISTS(SELECT 1 FROM push_subscriptions)
          AND (NEW.type='approval.requested' OR (NEW.type='turn.completed' AND json_extract(NEW.payload,'$.status') IN ('completed','failed')))
        BEGIN
          INSERT OR IGNORE INTO push_notices(id,eventKey,client,target,category,kind,createdAt)
          VALUES(lower(hex(randomblob(16))), 'codex:'||NEW.threadId||':'||COALESCE(NEW.turnId,CAST(NEW.seq AS TEXT))||':'||NEW.type||':'||COALESCE(json_extract(NEW.payload,'$.id'),'')||':'||COALESCE(json_extract(NEW.payload,'$.status'),''),
            'codex',NEW.threadId,
            CASE WHEN NEW.type='approval.requested' THEN 'attention' WHEN json_extract(NEW.payload,'$.status')='failed' THEN 'errors' ELSE 'completed' END,
            CASE WHEN NEW.type='approval.requested' THEN CASE WHEN json_extract(NEW.payload,'$.kind')='question' THEN 'question' ELSE 'approval' END WHEN json_extract(NEW.payload,'$.status')='failed' THEN 'failed' ELSE 'completed' END,
            CAST(unixepoch('subsec')*1000 AS INTEGER));
        END;
        CREATE TRIGGER push_gpt_job AFTER UPDATE OF status ON gpt_jobs
        WHEN NEW.status<>OLD.status AND NEW.status IN ('completed','failed','unknown') AND EXISTS(SELECT 1 FROM push_subscriptions)
        BEGIN
          INSERT OR IGNORE INTO push_notices(id,eventKey,client,target,category,kind,createdAt)
          VALUES(lower(hex(randomblob(16))),'gpt:'||NEW.id||':'||NEW.status,'gpt',NEW.id,CASE WHEN NEW.status='completed' THEN 'completed' ELSE 'errors' END,NEW.status,CAST(unixepoch('subsec')*1000 AS INTEGER));
        END;
        CREATE TRIGGER push_codex_queue AFTER UPDATE OF state ON queue_transfers
        WHEN NEW.state<>OLD.state AND NEW.state IN ('unknown','enqueue_unknown') AND EXISTS(SELECT 1 FROM push_subscriptions)
        BEGIN
          INSERT OR IGNORE INTO push_notices(id,eventKey,client,target,category,kind,createdAt)
          VALUES(lower(hex(randomblob(16))),'queue:'||NEW.threadId||':'||NEW.id,'codex',NEW.threadId,'errors','unknown',CAST(unixepoch('subsec')*1000 AS INTEGER));
        END;
        CREATE TRIGGER push_codex_lost AFTER UPDATE OF status ON threads
        WHEN NEW.status='unknown' AND OLD.status IN ('running','starting','waiting_approval') AND EXISTS(SELECT 1 FROM push_subscriptions)
        BEGIN
          INSERT OR IGNORE INTO push_notices(id,eventKey,client,target,category,kind,createdAt)
          VALUES(lower(hex(randomblob(16))),'lost:'||NEW.id||':'||COALESCE(NEW.activeTurnId,NEW.updatedAt),'codex',NEW.id,'errors','unknown',CAST(unixepoch('subsec')*1000 AS INTEGER));
        END;
      `);
    },
  },
  {
    version: 11,
    name: "immutable_project_artifacts",
    up(db) {
      db.exec(`CREATE TABLE artifact_files(
        id TEXT PRIMARY KEY REFERENCES artifacts(id), name TEXT NOT NULL,
        sha256 TEXT NOT NULL, sourcePath TEXT NOT NULL, turnId TEXT
      );
      CREATE TABLE artifact_captures(id TEXT PRIMARY KEY, threadId TEXT NOT NULL REFERENCES threads(id),
        turnId TEXT, path TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL, artifactId TEXT);
      CREATE INDEX artifact_captures_thread ON artifact_captures(threadId);`);
    },
  },
  {
    version: 12,
    name: "workspace_notes_and_context_bookmarks",
    up(db) {
      db.exec(`
      CREATE TABLE workspace_notes(id TEXT PRIMARY KEY,scopeKey TEXT NOT NULL,scope TEXT,title TEXT NOT NULL,body TEXT NOT NULL,search TEXT NOT NULL,links TEXT NOT NULL,revision INTEGER NOT NULL,createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL);
      CREATE INDEX workspace_notes_scope ON workspace_notes(scopeKey,updatedAt DESC);
      CREATE TABLE workspace_pins(id TEXT PRIMARY KEY,scopeKey TEXT NOT NULL,scope TEXT,targetKey TEXT NOT NULL,target TEXT NOT NULL,createdAt INTEGER NOT NULL,UNIQUE(scopeKey,targetKey));
      CREATE INDEX workspace_pins_scope ON workspace_pins(scopeKey,createdAt DESC);
    `);
    },
  },
  {
    version: 13,
    name: "workspace-tasks",
    up(db) {
      db.exec(
        "CREATE TABLE workspace_tasks(id TEXT PRIMARY KEY,scopeKey TEXT NOT NULL,scope TEXT,title TEXT NOT NULL,body TEXT NOT NULL,search TEXT NOT NULL,links TEXT NOT NULL,revision INTEGER NOT NULL,createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL,status TEXT NOT NULL,priority INTEGER NOT NULL,dueAt TEXT,completedAt INTEGER); CREATE INDEX workspace_tasks_scope ON workspace_tasks(scopeKey,status,priority DESC,updatedAt DESC); CREATE INDEX workspace_tasks_done ON workspace_tasks(status,completedAt DESC)",
      );
    },
  },
  {
    version: 14,
    name: "captured-notes",
    up(db) {
      db.exec(
        "CREATE TABLE workspace_note_sources(noteId TEXT PRIMARY KEY REFERENCES workspace_notes(id) ON DELETE CASCADE,fingerprint TEXT UNIQUE NOT NULL,source TEXT NOT NULL)",
      );
    },
  },
  {
    version: 15,
    name: "project-core-history",
    up(db) {
      db.exec(`
    CREATE TABLE project_cores(scopeKey TEXT PRIMARY KEY,scope TEXT NOT NULL,value TEXT NOT NULL,revision INTEGER NOT NULL,createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL);
    CREATE TABLE project_core_history(scopeKey TEXT NOT NULL REFERENCES project_cores(scopeKey) ON DELETE CASCADE,revision INTEGER NOT NULL,value TEXT NOT NULL,createdAt INTEGER NOT NULL,PRIMARY KEY(scopeKey,revision));
  `);
    },
  },
  {
    version: 16,
    name: "project-plans-and-work-receipts",
    up(db) {
      db.exec(`
 CREATE TABLE project_plans(id TEXT PRIMARY KEY,scopeKey TEXT NOT NULL,scope TEXT NOT NULL,value TEXT NOT NULL,search TEXT NOT NULL,revision INTEGER NOT NULL,createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL);
 CREATE INDEX project_plans_scope ON project_plans(scopeKey,updatedAt DESC);
 CREATE TABLE project_work_actions(id TEXT PRIMARY KEY,scopeKey TEXT NOT NULL,kind TEXT NOT NULL,planId TEXT,state TEXT NOT NULL,fingerprint TEXT NOT NULL,value TEXT NOT NULL,createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL);
 CREATE INDEX project_work_actions_scope ON project_work_actions(scopeKey,createdAt DESC);
 CREATE TABLE project_reports(id TEXT PRIMARY KEY,scopeKey TEXT NOT NULL,scope TEXT NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,actionId TEXT UNIQUE NOT NULL,source TEXT NOT NULL,periodFrom INTEGER NOT NULL,periodTo INTEGER NOT NULL,watermarks TEXT NOT NULL,createdAt INTEGER NOT NULL);
 CREATE INDEX project_reports_scope ON project_reports(scopeKey,createdAt DESC);
 CREATE TABLE project_current_chats(scopeKey TEXT PRIMARY KEY,scope TEXT NOT NULL,threadId TEXT NOT NULL,revision INTEGER NOT NULL,updatedAt INTEGER NOT NULL);
 CREATE TABLE project_chat_history(scopeKey TEXT NOT NULL,threadId TEXT NOT NULL,title TEXT NOT NULL,rotatedAt INTEGER NOT NULL,PRIMARY KEY(scopeKey,threadId));
 `);
    },
  },
  {
    version: 17,
    name: "gpt-project-bootstrap-binding",
    up(db) {
      db.exec(
        "CREATE TABLE gpt_project_jobs(jobId TEXT PRIMARY KEY REFERENCES gpt_jobs(id) ON DELETE CASCADE,projectId TEXT NOT NULL,verified INTEGER NOT NULL DEFAULT 0,checkedAt INTEGER NOT NULL DEFAULT 0)",
      );
    },
  },
  {
    version: 18,
    name: "durable-project-setup",
    up(db) {
      db.exec(
        "CREATE TABLE project_setup_operations(id TEXT PRIMARY KEY,machineId TEXT NOT NULL,state TEXT NOT NULL,value TEXT NOT NULL,createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL); CREATE INDEX project_setup_pending ON project_setup_operations(machineId,state,updatedAt)",
      );
    },
  },
  {
    version: 19,
    name: "private-bridge-doctor",
    up(db) {
      db.exec(
        "ALTER TABLE threads ADD COLUMN diagnostic INTEGER NOT NULL DEFAULT 0; CREATE TABLE bridge_doctor_config(id INTEGER PRIMARY KEY CHECK(id=1),value TEXT NOT NULL); CREATE TABLE bridge_doctor_incidents(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,state TEXT NOT NULL,lastSeen INTEGER NOT NULL,value TEXT NOT NULL); CREATE INDEX bridge_doctor_fingerprint ON bridge_doctor_incidents(fingerprint,lastSeen);",
      );
    },
  },
  {
    version: 20,
    name: "private-device-terminals",
    up(db) {
      db.exec(
        "CREATE TABLE device_terminals(id TEXT PRIMARY KEY,deviceId TEXT NOT NULL,owner TEXT NOT NULL,title TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('open','closed')),createdAt TEXT NOT NULL,exitCode INTEGER); CREATE INDEX device_terminals_owner ON device_terminals(owner,state,createdAt)",
      );
    },
  },
  {
    version: 21,
    name: "project-work-reviews",
    up(db) {
      db.exec(
        "CREATE TABLE work_reviews(id TEXT PRIMARY KEY,scopeKey TEXT NOT NULL,threadId TEXT NOT NULL,turnId TEXT,state TEXT NOT NULL,revision INTEGER NOT NULL,value TEXT NOT NULL,createdAt INTEGER NOT NULL); CREATE INDEX work_reviews_scope ON work_reviews(scopeKey,createdAt DESC,id); CREATE INDEX work_reviews_thread ON work_reviews(threadId,turnId); CREATE TABLE work_review_receipts(id TEXT PRIMARY KEY,reviewId TEXT NOT NULL,fingerprint TEXT NOT NULL,response TEXT NOT NULL)",
      );
    },
  },
  {
    version: 22,
    name: "plan-reconciliation-proposals",
    up(db) {
      db.exec(
        "CREATE TABLE plan_reconciliations(actionId TEXT PRIMARY KEY,planId TEXT NOT NULL,planRevision INTEGER NOT NULL,value TEXT NOT NULL,createdAt INTEGER NOT NULL); CREATE INDEX plan_reconciliations_plan ON plan_reconciliations(planId,createdAt DESC)",
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
