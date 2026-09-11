import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { inspectMachineStaging } from "@codex-web/machines";
import { HubError } from "@codex-web/shared";
import { loadConfig } from "./config.js";
import { maintainMachineStaging } from "./staging-maintenance.js";
import { compactStorage, storageReport } from "./storage.js";

async function run() {
  const { values } = parseArgs({
    options: {
      config: { type: "string" },
      apply: { type: "boolean" },
      destination: { type: "string" },
      revision: { type: "string" },
      "staging-machine": { type: "string" },
    },
  });
  if (!values.config || (values.apply && !values.destination))
    throw new HubError(
      400,
      "STORAGE_USAGE",
      "Нужен --config; для --apply также --destination с каталогом резервных копий.",
    );
  const config = loadConfig(values.config);
  if (values["staging-machine"]) {
    const id = values["staging-machine"],
      machine = config.machines.find((m) => m.id === id && m.type === "ssh-windows");
    if (!machine) throw new HubError(404, "MACHINE_NOT_FOUND", "Компьютер не найден.");
    console.log(
      JSON.stringify(
        values.apply
          ? await maintainMachineStaging(config, id, values.destination!)
          : await inspectMachineStaging(machine),
        null,
        2,
      ),
    );
    return;
  }
  if (values.apply)
    console.log(
      JSON.stringify({
        ok: true,
        ...(await compactStorage(config, {
          backupDirectory: values.destination!,
          revision: values.revision,
        })),
      }),
    );
  else {
    const db = new DatabaseSync(config.hub.databasePath, { readOnly: true });
    try {
      console.log(JSON.stringify(await storageReport(config, db), null, 2));
    } finally {
      db.close();
    }
  }
}
process.umask(0o077);
void run().catch((error) => {
  console.error(
    JSON.stringify({
      ok: false,
      code: error instanceof HubError ? error.code : "STORAGE_MAINTENANCE_FAILED",
      message:
        error instanceof HubError
          ? error.message
          : "Очистка не завершена. Резервная копия и исходная история сохранены.",
    }),
  );
  process.exitCode = 1;
});
