import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { hostLock } from "../apps/hub/dist/host-lock.js";
import { Store } from "../apps/hub/dist/store.js";
import { TeamGpt } from "../apps/hub/dist/team-gpt.js";
import { reconcileGptProfiles } from "../apps/hub/dist/team-gpt-host.js";
import { createTeamSnapshot, restoreTeamSnapshot } from "../apps/hub/dist/team-maintenance.js";
import {
  createProfileSnapshot,
  restoreProfileSnapshot,
  verifyProfileSnapshot,
} from "../apps/hub/dist/team-profile-backup.js";
import { TeamStore } from "../apps/hub/dist/team-store.js";
import { configSchema } from "../packages/shared/dist/index.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "cw-profile-backup-"));
  const config = configSchema.parse({
    hub: {
      publicBaseUrl: "https://fixture.invalid",
      databasePath: join(root, "owner.db"),
      resultsPath: join(root, "results"),
    },
    auth: { username: "owner" },
    machines: [],
    projects: [],
    team: {
      enabled: true,
      root: join(root, "team"),
      gptProfiles: { enabled: true, maxProfiles: 2 },
    },
  });
  const store = new Store(config.hub.databasePath);
  store.db.prepare("INSERT INTO users VALUES('owner','fixture')").run();
  const registry = new TeamStore(join(config.team.root, "team.db"), config, store),
    gpt = new TeamGpt(config, registry);
  registry.db
    .prepare("UPDATE team_namespaces SET initialized=1 WHERE userId=?")
    .run(registry.ownerId);
  const invite = registry.invite(registry.ownerId, "Friend", "member");
  const member = registry.accept(invite.token, "friend", "Friend", "unused", 10);
  gpt.request(registry.ownerId);
  gpt.request(member.id);
  const rows = [gpt.row(registry.ownerId), gpt.row(member.id)],
    paths = [];
  for (const row of rows) {
    const path = join(config.team.root, "users", row.userId, "gpt");
    paths.push(path);
    await mkdir(join(path, "profile", "Default"), { recursive: true, mode: 0o700 });
    for (const [name, value] of Object.entries({
      "service-token": row.serviceToken,
      "bridge-token": row.bridgeToken,
      "vnc-password": row.vncPassword,
      "profile/Default/Cookies": "private-cookie-fixture-" + row.userId,
      "profile/Local State": '{"test":true}',
    }))
      await writeFile(join(path, name), value, { mode: 0o600 });
    await symlink(
      "/tmp/nonexistent-codex-web-test-socket",
      join(path, "profile", "SingletonSocket"),
    );
  }
  let running = false,
    tamper;
  const containers = paths.map((path, i) => ({
    Id: String(i + 1).repeat(12),
    State: { Running: false, Status: "exited" },
    Mounts: [{ Type: "bind", Source: path, Destination: "/data" }],
  }));
  const run = async (args) => {
    if (args[1] === "ls") return containers.map((c) => c.Id).join("\n");
    if (args[1] === "inspect") {
      tamper?.();
      return JSON.stringify(
        containers.map((c) => ({
          ...c,
          State: { Running: running, Status: running ? "running" : "exited" },
        })),
      );
    }
    throw Error("Unexpected mutation of Docker");
  };
  t.after(async () => {
    registry.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    config,
    store,
    registry,
    rows,
    paths,
    run,
    containers,
    running: (v) => {
      running = v;
    },
    tamper: (fn) => {
      tamper = fn;
    },
  };
}
test("stopped GPT profiles keep account identity and private bytes through separate team restore", async (t) => {
  const f = await fixture(t);
  const checkpoint = await createTeamSnapshot(f.config, join(f.root, "backups"));
  const snapshot = await createProfileSnapshot(f.config, join(f.root, "profiles"), { run: f.run });
  const manifest = await verifyProfileSnapshot(snapshot);
  assert.equal(manifest.profiles.length, 2);
  assert.equal(manifest.ownerId, f.registry.ownerId);
  assert(!JSON.stringify(manifest).includes(f.rows[0].serviceToken));
  assert(!JSON.stringify(manifest).includes("Singleton"));
  const target = join(f.root, "restored");
  await restoreTeamSnapshot(checkpoint, target);
  const restored = await restoreProfileSnapshot(snapshot, join(target, "team"));
  assert.equal(restored.nativeAdmission, "blocked");
  assert.equal(
    await readFile(join(restored.path, f.rows[1].userId, "profile/Default/Cookies"), "utf8"),
    "private-cookie-fixture-" + f.rows[1].userId,
  );
  const db = new DatabaseSync(join(target, "team", "team.db"));
  assert.equal(
    db.prepare("SELECT value FROM team_meta WHERE key='nativeAdmission'").get().value,
    "blocked",
  );
  assert.equal(db.prepare("SELECT COUNT(*) n FROM team_sessions").get().n, 0);
  db.close();
  await assert.rejects(
    restoreProfileSnapshot(snapshot, join(target, "team")),
    /PROFILE_RESTORE_EXISTS/,
  );
});
test("backup refuses running browsers and held OS locks; host preparation cannot race a copy", async (t) => {
  const f = await fixture(t),
    dest = join(f.root, "snapshots");
  f.running(true);
  await assert.rejects(
    createProfileSnapshot(f.config, dest, { run: f.run }),
    /PROFILE_BROWSER_MUST_BE_STOPPED/,
  );
  f.running(false);
  const browser = await hostLock(join(f.paths[0], "browser.lock"));
  try {
    await assert.rejects(createProfileSnapshot(f.config, dest, { run: f.run }), /HOST_LOCK_BUSY/);
  } finally {
    await browser.close();
  }
  const host = await hostLock(join(f.config.team.root, "gpt-host.lock"));
  try {
    await assert.rejects(createProfileSnapshot(f.config, dest, { run: f.run }), /HOST_LOCK_BUSY/);
    await assert.rejects(
      reconcileGptProfiles(f.config, f.registry.db, { image: "codex-web-gpt:abcdef0", run: f.run }),
      /HOST_LOCK_BUSY/,
    );
  } finally {
    await host.close();
  }
  assert.equal((await readdir(dest)).length, 0);
});
test("profile restore denies identity swaps, checksum damage, active admission and unowned links", async (t) => {
  const f = await fixture(t),
    dest = join(f.root, "snapshots");
  await symlink(join(f.root, "owner.db"), join(f.paths[0], "profile", "private-link"));
  await assert.rejects(
    createProfileSnapshot(f.config, dest, { run: f.run }),
    /PROFILE_BACKUP_LINK/,
  );
  await rm(join(f.paths[0], "profile", "private-link"));
  const snapshot = await createProfileSnapshot(f.config, dest, { run: f.run });
  await assert.rejects(
    restoreProfileSnapshot(snapshot, f.config.team.root),
    /RESTORE_ADMISSION_REQUIRED/,
  );
  f.registry.db.prepare("INSERT INTO team_meta VALUES('nativeAdmission','blocked')").run();
  const original = f.rows[0].serviceToken;
  f.registry.db
    .prepare("UPDATE team_gpt_profiles SET serviceToken=? WHERE userId=?")
    .run("a".repeat(43), f.rows[0].userId);
  await assert.rejects(
    restoreProfileSnapshot(snapshot, f.config.team.root),
    /PROFILE_OWNER_MAPPING/,
  );
  f.registry.db
    .prepare("UPDATE team_gpt_profiles SET serviceToken=? WHERE userId=?")
    .run(original, f.rows[0].userId);
  const cookie = join(snapshot, f.rows[0].userId, "profile/Default/Cookies");
  await writeFile(cookie, "changed");
  await assert.rejects(verifyProfileSnapshot(snapshot), /PROFILE_BACKUP_CHECKSUM/);
});
test("connector mismatch, missing container mapping, unsafe output and changing ownership abort snapshots", async (t) => {
  const f = await fixture(t),
    dest = join(f.root, "snapshots");
  await assert.rejects(
    createProfileSnapshot(f.config, join(f.paths[0], "backups"), { run: f.run }),
    /PROFILE_BACKUP_PATH/,
  );
  // Unsafe destinations are not accepted even when no copy has begun.
  const open = join(f.root, "world-readable");
  await mkdir(open, { mode: 0o755 });
  await chmod(open, 0o755);
  await assert.rejects(
    createProfileSnapshot(f.config, open, { run: f.run }),
    /PROFILE_BACKUP_PERMISSIONS/,
  );
  f.containers.pop();
  await assert.rejects(
    createProfileSnapshot(f.config, dest, { run: f.run }),
    /PROFILE_CONTAINER_MAPPING_MISSING/,
  );
  f.containers.push({
    Id: "3".repeat(12),
    State: { Running: false, Status: "exited" },
    Mounts: [{ Type: "bind", Source: f.paths[1], Destination: "/data" }],
  });
  await writeFile(join(f.paths[0], "service-token"), "wrong");
  await assert.rejects(
    createProfileSnapshot(f.config, dest, { run: f.run }),
    /PROFILE_CONNECTOR_MAPPING/,
  );
  await writeFile(join(f.paths[0], "service-token"), f.rows[0].serviceToken);
  let checks = 0;
  f.tamper(() => {
    if (++checks === 2)
      f.registry.db
        .prepare("UPDATE team_gpt_profiles SET slot=8 WHERE userId=?")
        .run(f.rows[0].userId);
  });
  await assert.rejects(
    createProfileSnapshot(f.config, dest, { run: f.run }),
    /PROFILE_OWNER_MAPPING_CHANGED/,
  );
});
