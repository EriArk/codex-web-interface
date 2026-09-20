import { lstatSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { loadConfig } from "./config.js";
import { reconcileGptProfiles } from "./team-gpt-host.js";

async function main() {
  const { values } = parseArgs({
    options: {
      config: { type: "string" },
      image: { type: "string" },
      "native-image": { type: "string" },
      seccomp: { type: "string" },
      apply: { type: "boolean" },
    },
  });
  if (!values.config || !values.image)
    throw Error("Use --config and --image; --apply enables host preparation.");
  const config = loadConfig(values.config);
  if (!config.team?.enabled) throw Error("TEAM_DISABLED");
  const path = join(config.team.root, "team.db"),
    stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    realpathSync(path) !== resolve(path) ||
    stat.mode & 0o077 ||
    process.getuid?.() !== 1000 ||
    stat.uid !== 1000
  )
    throw Error("TEAM_STORAGE_UNSAFE");
  const db = new DatabaseSync(path, { readOnly: !values.apply });
  try {
    db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
    // Later Team migrations retain the same profile/user tables used here.
    if (
      !["3", "4", "5", "6", "7", "8", "9"].includes(
        String(db.prepare("SELECT value FROM team_meta WHERE key='schema'").get()?.value),
      )
    )
      throw Error("TEAM_SCHEMA_UNSUPPORTED");
    if (!values.apply) {
      const rows = db
        .prepare("SELECT state,COUNT(*) count FROM team_gpt_profiles GROUP BY state")
        .all();
      console.log(JSON.stringify({ apply: false, profiles: rows }));
    } else
      console.log(
        JSON.stringify(
          await reconcileGptProfiles(config, db, {
            image: values.image,
            nativeImage: values["native-image"],
            seccompPath: values.seccomp,
          }),
        ),
      );
  } finally {
    db.close();
  }
}
main().catch(() => {
  console.error("TEAM_GPT_HOST_PREPARATION_FAILED");
  process.exitCode = 1;
});
