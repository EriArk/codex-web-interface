import { lstatSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { HubConfig } from "@codex-web/shared";
import { NativeGptReadClient } from "./gpt-native.js";
import type { NativeGptWorkspace } from "./gpt-native-provider.js";
/** Host-only, original-owner admission. No request can select a socket/account. */
export function configuredNativeGpt(
  config: HubConfig,
  authorize: () => void,
): NativeGptWorkspace | undefined {
  const selected = config.nativeGpt;
  if (!selected) return;
  const guard = () => {
    authorize();
    const root = dirname(selected.socketPath),
      path = join(root, "binding.json");
    for (const [p, directory] of [
      [root, true],
      [path, false],
    ] as const) {
      const st = lstatSync(p);
      if (
        st.uid !== process.getuid?.() ||
        st.mode & 0o077 ||
        (directory ? !st.isDirectory() : !st.isFile())
      )
        throw Error("NATIVE_UNSAFE_BINDING");
    }
    const bound = JSON.parse(readFileSync(path, "utf8"));
    if (
      bound.build !== "26.915.31945" ||
      bound.userId !== selected.userId ||
      bound.accountFingerprint !== selected.accountFingerprint
    )
      throw Error("NATIVE_BINDING_MISMATCH");
  };
  const uuid = { has: (id: string) => /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id) };
  const client = new NativeGptReadClient(selected, guard);
  return {
    client,
    transcribe: client.transcribe.bind(client),
    conversations: uuid,
    creationKeys: uuid,
    projects: { has: (id: string) => /^g-p-[a-zA-Z0-9-]{1,80}$/.test(id) },
  };
}
