import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { HubError } from "@codex-web/shared";
import type { NativeGptWorkspace } from "./gpt-native-provider.js";
import type { GptProjectInput, NativeProjectTransport } from "./gpt-project-content.js";

export function nativeProjectTransport(
  workspace: NativeGptWorkspace,
  resolve: (id: string) => { path: string; id: string; name: string; bytes: number; mime: string },
  authorize: () => void,
): NativeProjectTransport {
  return {
    read: async (id) => {
      authorize();
      const p = await workspace.client.projectContent(id);
      authorize();
      return { ...p, canWrite: p.canWrite && workspace.projects?.has(id) === true };
    },
    execute: async (key: string, input: GptProjectInput) => {
      authorize();
      if (!workspace.projects?.has(input.projectId))
        throw new HubError(
          409,
          "GPT_PROJECT_NOT_ADMITTED",
          "Проект пока не подключён к новому клиенту.",
        );
      if (input.action !== "upload") return workspace.client.projectMutation({ key, ...input });
      const f = resolve(input.uploadId),
        digest = createHash("sha256");
      let bytes = 0;
      for await (const chunk of createReadStream(f.path)) {
        authorize();
        bytes += chunk.length;
        digest.update(chunk);
      }
      if (bytes !== f.bytes)
        throw new HubError(409, "UPLOAD_CHANGED", "Файл изменился. Загрузи его снова.");
      authorize();
      return workspace.client.projectMutation(
        {
          key,
          projectId: input.projectId,
          revision: input.revision,
          action: "upload",
          file: {
            id: f.id,
            name: f.name,
            mime: f.mime,
            bytes: f.bytes,
            sha256: digest.digest("hex"),
          },
        },
        f.path,
      );
    },
    check: async (key, id) => {
      authorize();
      return workspace.client.reconcileProject(key, id);
    },
  };
}
