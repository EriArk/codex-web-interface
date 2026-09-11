import { inspectMachineStaging } from "@codex-web/machines";
import type { HubConfig, StagingInventory } from "@codex-web/shared";
import type { FastifyInstance } from "fastify";
export function registerStagingStorage(
  app: FastifyInstance,
  config: HubConfig,
  probe = inspectMachineStaging,
) {
  type Row = { id: string; name: string; available: boolean; inventory?: StagingInventory };
  let pending: Promise<{ machines: Row[] }> | undefined,
    cached: { at: number; value: { machines: Row[] } } | undefined;
  app.get("/api/storage/staging", async () => {
    if (cached && Date.now() - cached.at < 60000) return cached.value;
    if (pending) return pending;
    pending = (async () => {
      const machines: Row[] = [],
        queue = config.machines.filter((m) => m.type === "ssh-windows");
      await Promise.all(
        [0, 1].map(async () => {
          while (queue.length) {
            const machine = queue.shift()!;
            try {
              const v = await probe(machine);
              const inventory: StagingInventory = {
                bytes: v.bytes,
                files: v.files,
                temporaryBytes: v.temporaryBytes,
                temporaryFiles: v.temporaryFiles,
                previewBytes: v.previewBytes,
                receipts: v.receipts,
                partial: v.partial,
                checkedAt: v.checkedAt,
              };
              machines.push({ id: machine.id, name: machine.name, available: true, inventory });
            } catch {
              machines.push({ id: machine.id, name: machine.name, available: false });
            }
          }
        }),
      );
      const value = { machines: machines.sort((a, b) => a.name.localeCompare(b.name)) };
      cached = { at: Date.now(), value };
      return value;
    })();
    try {
      return await pending;
    } finally {
      pending = undefined;
    }
  });
  app.addHook("preClose", async () => {
    if (pending) await pending;
  });
}
