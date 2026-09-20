// Opt-in empty-profile smoke; never loads production config or account data.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { Store } from "../apps/hub/dist/store.js";
import { TeamStore } from "../apps/hub/dist/team-store.js";
import { TeamGpt, teamGptName } from "../apps/hub/dist/team-gpt.js";
import { reconcileGptProfiles } from "../apps/hub/dist/team-gpt-host.js";
import { NativeGptReadClient } from "../apps/hub/dist/gpt-native.js";
import { configSchema } from "../packages/shared/dist/index.js";
if (process.platform !== "linux" || process.getuid() !== 1000 || !process.env.TEAM_QA_NATIVE_IMAGE)
  throw Error("Explicit Linux QA image required");
mkdirSync(".local", { recursive: true });
const root = mkdtempSync(resolve(".local/native-member-"));
const config = configSchema.parse({
  hub: {
    publicBaseUrl: "https://fixture.invalid",
    databasePath: join(root, "owner.db"),
    resultsPath: join(root, "results"),
  },
  auth: { username: "fixture" },
  team: {
    enabled: true,
    root: join(root, "team"),
    gptProfiles: { enabled: true, runtime: "native", maxProfiles: 1, portBase: 18900 },
  },
  machines: [],
  projects: [],
});
const store = new Store(config.hub.databasePath);
store.db.prepare("INSERT INTO users VALUES('fixture','unused')").run();
const registry = new TeamStore(join(config.team.root, "team.db"), config, store),
  gpt = new TeamGpt(config, registry),
  id = registry.ownerId,
  name = teamGptName(id);
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", timeout: 45000 });
try {
  gpt.request(id);
  const options = {
    image: process.env.TEAM_QA_GPT_IMAGE,
    nativeImage: process.env.TEAM_QA_NATIVE_IMAGE,
    seccompPath: resolve("ops/gpt-native/seccomp.json"),
  };
  for (let i = 0; i < 18 && gpt.row(id).state !== "ready"; i++) {
    await reconcileGptProfiles(config, registry.db, options);
    assert.notEqual(gpt.row(id).state, "failed", gpt.row(id).code);
    if (gpt.row(id).state !== "ready") await new Promise((r) => setTimeout(r, 2000));
  }
  assert.equal(gpt.row(id).state, "ready");
  const rootProfile = join(config.team.root, "users", id, "gpt"),
    client = new NativeGptReadClient(
      { userId: id, socketPath: join(rootProfile, "native-adapter/adapter.sock") },
      () => {},
    );
  assert.equal((await client.status()).manual, false);
  // The signed-out native window has no authenticated shell yet. Neither that
  // window nor an unavailable account may activate someone else's workspace.
  let code = "";
  for (let i = 0; i < 12; i++) {
    try {
      await client.activate();
      assert.fail("empty profile must not activate");
    } catch (e) {
      code = e.message;
    }
    if (["NATIVE_ACCOUNT_UNAVAILABLE", "NATIVE_WINDOW_AMBIGUOUS"].includes(code)) break;
    await new Promise((r) => setTimeout(r, 1500));
  }
  assert(["NATIVE_ACCOUNT_UNAVAILABLE", "NATIVE_WINDOW_AMBIGUOUS"].includes(code), code);
  assert.match(docker("exec", name, "xwininfo", "-root", "-tree"), /ChatGPT|Codex/);
  assert.equal(existsSync(join(rootProfile, "native-adapter/binding.json")), false);
  const containers = JSON.parse(docker("inspect", name, name + "-edge", name + "-remote"));
  assert.equal(Object.keys(containers[0].HostConfig.PortBindings ?? {}).length, 0);
  assert.equal(containers[0].Mounts.length, 1);
  assert.equal(containers[0].HostConfig.CapDrop.includes("ALL"), true);
  assert.equal(containers[0].NetworkSettings.Networks[name] !== undefined, true);
  // Reconcile the same request again without creating a second runtime.
  registry.db.prepare("UPDATE team_gpt_profiles SET state='requested' WHERE userId=?").run(id);
  assert.equal((await reconcileGptProfiles(config, registry.db, options)).prepared, 1);
  assert.equal(JSON.parse(docker("inspect", name))[0].Id, containers[0].Id);
  console.log(
    "Empty native member client: isolated profile, logged-out account, private Remote, idempotent host preparation.",
  );
} finally {
  for (const n of [name, name + "-edge", name + "-remote"])
    try {
      docker("rm", "-f", n);
    } catch {}
  for (const n of [name, name + "-out"])
    try {
      docker("network", "rm", n);
    } catch {}
  registry.close();
  store.close();
  rmSync(root, { recursive: true, force: true });
}
