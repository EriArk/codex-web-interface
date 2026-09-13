import { createHash } from "node:crypto";
import { projectFilePath } from "@codex-web/machines";
import { HubError, type MachineConfig } from "@codex-web/shared";
import { z } from "zod";
import type { Store, ThreadRecord } from "./store.js";

export const resultReferenceSchema = z.object({
  source: z.string().max(8192),
  sourceHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  messageId: z.string().min(1).max(200),
  turnId: z.string().max(200).nullable().optional(),
});
export function resolveResultReference(
  store: Store,
  thread: ThreadRecord,
  machine: MachineConfig,
  root: string,
  ref: z.infer<typeof resultReferenceSchema>,
) {
  const missing = () =>
    new HubError(
      404,
      "RESULT_NOT_FOUND",
      "Этот файл или изображение не найдены в результатах сообщения. Возможно, они ещё не сохранены или уже удалены.",
    );
  // Direct Hub links still have to belong to the authorized source conversation.
  let row = /^\/api\/(?:artifacts|native-images|previews)\/[a-zA-Z0-9_-]+$/.test(ref.source)
    ? store.db
        .prepare(
          "SELECT id FROM results WHERE threadId=? AND json_extract(payload,'$.url')=? LIMIT 1",
        )
        .get(thread.id, ref.source)
    : undefined;
  if (!row) {
    const sourceKey = ref.sourceHash || createHash("sha256").update(ref.source).digest("hex");
    const image = store.db
      .prepare("SELECT id FROM native_images WHERE threadId=? AND messageId=? AND sourceKey=?")
      .get(thread.id, "result:" + ref.messageId, sourceKey);
    if (image)
      row = store.db
        .prepare("SELECT id FROM results WHERE threadId=? AND sourceKey=?")
        .get(thread.id, "image:" + image.id);
  }
  if (!row && !ref.sourceHash) {
    let path: string;
    try {
      path = projectFilePath(machine, root, ref.source.replace(/:\d+(?::\d+)?$/, ""));
    } catch {
      throw missing();
    }
    // Same identity used at capture time: never substitute the latest file with
    // that basename, a different turn's snapshot, or another project's export.
    const captureId = createHash("sha256")
      .update(JSON.stringify([thread.id, ref.turnId ?? null, ref.messageId, path]))
      .digest("hex");
    row = store.db
      .prepare("SELECT id FROM results WHERE threadId=? AND sourceKey=?")
      .get(thread.id, "artifact:" + captureId);
  }
  if (!row) throw missing();
  return store.resultById(thread.id, String(row.id));
}
