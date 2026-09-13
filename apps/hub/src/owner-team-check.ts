import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadConfig } from "./config.js";
import { engineInfo } from "./engine-client.js";

// Release admission probe: read-only, no native writer, account login or prompt.
const config = loadConfig(process.env.HUB_CONFIG ?? "/config/config.json");
assert(config.team?.enabled && config.team.registrationEnabled === false);
const personal = new DatabaseSync(config.hub.databasePath, { readOnly: true });
const registry = new DatabaseSync(join(config.team.root, "team.db"), { readOnly: true });
try {
  assert.equal(registry.prepare("PRAGMA quick_check").get()?.quick_check, "ok");
  assert.equal(registry.prepare("PRAGMA foreign_key_check").all().length, 0);
  assert.equal(registry.prepare("SELECT count(*) n FROM team_users").get()?.n, 1);
  const id = registry.prepare("SELECT value FROM team_meta WHERE key='originalOwner'").get()?.value;
  const owner = registry.prepare("SELECT * FROM team_users WHERE id=?").get(String(id));
  const credential = personal
    .prepare("SELECT passwordHash FROM users WHERE username=?")
    .get(config.auth.username);
  assert(owner && credential);
  assert.equal(owner.legacy, 1);
  assert.equal(owner.state, "active");
  assert.equal(owner.role, "admin");
  assert.equal(owner.login, config.auth.ownerLogin ?? config.auth.username);
  assert.equal(owner.passwordHash, credential.passwordHash);
  const info = (await engineInfo(
    process.env.HUB_ENGINE_SOCKET ?? "/run/codex-engine/engine.sock",
  )) as Awaited<ReturnType<typeof engineInfo>> & {
    team?: number;
    ownerReady?: boolean;
    registrationEnabled?: boolean;
  };
  assert.equal(info.team, 1);
  assert.equal(info.ownerReady, true);
  assert.equal(info.registrationEnabled, false);
  console.log(
    JSON.stringify({
      ok: true,
      ownerLogin: owner.login,
      passwordPreserved: true,
      ownerReady: true,
      registrationEnabled: false,
    }),
  );
} finally {
  registry.close();
  personal.close();
}
