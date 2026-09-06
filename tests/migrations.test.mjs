import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  migrateDatabase,
  migrations,
  SCHEMA_VERSION,
  schemaVersion,
} from "../apps/hub/dist/migrations.js";
import { Store } from "../apps/hub/dist/store.js";

const fixture = readFileSync(new URL("./fixtures/deployed-v1.sql", import.meta.url), "utf8");

test("empty and deployed version-1 databases upgrade with auth, history and native mappings intact", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-migrations-"));
  let db;
  try {
    const fresh = new Store(":memory:");
    assert.equal(fresh.schemaVersion, SCHEMA_VERSION);
    assert(fresh.db.prepare("SELECT 1 FROM sqlite_master WHERE name='history_cursors'").get());
    fresh.close();
    const path = join(root, "app.db");
    db = new DatabaseSync(path);
    db.exec(fixture);
    db.exec(`
      INSERT INTO users VALUES('owner','test-only-hash');
      INSERT INTO sessions VALUES('token','csrf',9999999999999);
      INSERT INTO threads(id,projectId,codexThreadId,title,createdAt,updatedAt) VALUES('t','p','native-t','keep','now','now');
      INSERT INTO messages VALUES('t','m',NULL,'user','final','retain text',1,1,'now');
      INSERT INTO results VALUES('r','t',NULL,'s','image','keep','{}','now');
      INSERT INTO catalog_projects VALUES('p','machine','native-p','{}');
      INSERT INTO history_cursors VALUES('cursor','t','{}',9999999999999);
    `);
    const tables = [
      "users",
      "sessions",
      "threads",
      "messages",
      "results",
      "catalog_projects",
      "history_cursors",
    ];
    const before = tables.map((table) => db.prepare("SELECT * FROM " + table).all());
    db.close();
    db = undefined;
    const upgraded = new Store(path);
    try {
      assert.equal(upgraded.schemaVersion, SCHEMA_VERSION);
      assert.deepEqual(
        tables.map((table) => upgraded.db.prepare("SELECT * FROM " + table).all()),
        before,
      );
      const checkpoints = readdirSync(join(root, "migration-backups"));
      assert.equal(checkpoints.length, 1);
      assert.equal(statSync(join(root, "migration-backups", checkpoints[0])).mode & 0o077, 0);
      const backup = new DatabaseSync(join(root, "migration-backups", checkpoints[0]), {
        readOnly: true,
      });
      assert.equal(schemaVersion(backup), 1);
      assert.equal(
        backup.prepare("SELECT passwordHash FROM users").get().passwordHash,
        "test-only-hash",
      );
      backup.close();
    } finally {
      upgraded.close();
    }
    const reopened = new Store(path);
    reopened.close();
    assert.equal(readdirSync(join(root, "migration-backups")).length, 1);
  } finally {
    db?.close();
    rmSync(root, { recursive: true });
  }
});
test("migration failure rolls back schema, rows and version as one transaction", () => {
  const db = new DatabaseSync(":memory:");
  try {
    migrateDatabase(db);
    assert.throws(
      () =>
        migrateDatabase(db, ":memory:", [
          ...migrations,
          {
            version: SCHEMA_VERSION + 1,
            name: "failure-fixture",
            up(database) {
              database.exec(
                "CREATE TABLE half_upgrade(id TEXT); INSERT INTO users VALUES('bad','bad')",
              );
              throw new Error("fixture abort");
            },
          },
        ]),
      /fixture abort/,
    );
    assert.equal(schemaVersion(db), SCHEMA_VERSION);
    assert.equal(
      db.prepare("SELECT 1 FROM sqlite_master WHERE name='half_upgrade'").get(),
      undefined,
    );
    assert.equal(db.prepare("SELECT 1 FROM users").get(), undefined);
  } finally {
    db.close();
  }
});
test("newer schema is refused without touching its data", () => {
  const db = new DatabaseSync(":memory:");
  try {
    migrateDatabase(db);
    assert.throws(() => migrateDatabase(db, ":memory:", migrations.slice(0, 1)), {
      code: "DB_SCHEMA_TOO_NEW",
    });
    assert.equal(schemaVersion(db), SCHEMA_VERSION);
  } finally {
    db.close();
  }
});
