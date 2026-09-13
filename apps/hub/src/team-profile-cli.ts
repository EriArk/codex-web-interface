import { parseArgs } from "node:util";
import { loadConfig } from "./config.js";
import {
  createProfileSnapshot,
  restoreProfileSnapshot,
  verifyProfileSnapshot,
} from "./team-profile-backup.js";

process.umask(0o077);
async function main() {
  const { values } = parseArgs({
    options: {
      config: { type: "string" },
      destination: { type: "string" },
      "legacy-profile": { type: "string" },
      verify: { type: "string" },
      restore: { type: "string" },
      "team-root": { type: "string" },
    },
  });
  if (
    values.verify &&
    !values.restore &&
    !values.config &&
    !values.destination &&
    !values["team-root"] &&
    !values["legacy-profile"]
  ) {
    const manifest = await verifyProfileSnapshot(values.verify);
    console.log(
      JSON.stringify({
        verified: true,
        ownerId: manifest.ownerId,
        profiles: manifest.profiles.length,
      }),
    );
  } else if (
    values.restore &&
    values["team-root"] &&
    !values.config &&
    !values.destination &&
    !values.verify &&
    !values["legacy-profile"]
  ) {
    console.log(JSON.stringify(await restoreProfileSnapshot(values.restore, values["team-root"])));
  } else if (
    values.config &&
    values.destination &&
    !values.verify &&
    !values.restore &&
    !values["team-root"]
  ) {
    const path = await createProfileSnapshot(loadConfig(values.config), values.destination, {
      legacyProfile: values["legacy-profile"],
    });
    console.log(JSON.stringify({ path, browsersChanged: false }));
  } else throw Error("PROFILE_BACKUP_ARGUMENTS");
}
void main().catch((error) => {
  // Paths, credentials, native profile data and child stderr never enter ordinary logs.
  const code =
    error instanceof Error &&
    /^(PROFILE_[A-Z_]+|HOST_LOCK_[A-Z_]+|LEGACY_PROFILE_MAPPING_REQUIRED|RESTORE_ADMISSION_REQUIRED|TEAM_DISABLED)$/.test(
      error.message,
    )
      ? error.message
      : "PROFILE_BACKUP_FAILED";
  console.error(JSON.stringify({ ok: false, code }));
  process.exitCode = 1;
});
