import { readWorkspaceDependencies, type WorkspaceDependencies } from "@codex-web/machines";
import type { MachineConfig } from "@codex-web/shared";
export type DynamicReply = {
  contentItems: { type: "inputText"; text: string }[];
  success: boolean;
};
const reply = (text: string, success = true): DynamicReply => ({
  contentItems: [{ type: "inputText", text }],
  success,
});
export async function workspaceTool(
  params: Record<string, unknown>,
  machine: MachineConfig,
  read: (machine: MachineConfig) => Promise<WorkspaceDependencies> = readWorkspaceDependencies,
): Promise<DynamicReply | null> {
  const name = params.tool;
  const namespace = params.namespace;
  if (
    !(
      (namespace === "codex_app" && name === "load_workspace_dependencies") ||
      ((namespace == null || namespace === "") &&
        ["codex_app__load_workspace_dependencies", "load_workspace_dependencies"].includes(
          String(name),
        ))
    )
  )
    return null;
  if (
    !params.arguments ||
    typeof params.arguments !== "object" ||
    Array.isArray(params.arguments) ||
    Object.keys(params.arguments).length
  )
    return reply("load_workspace_dependencies takes no arguments.", false);
  try {
    const data = await read(machine);
    if (!data.installed)
      return reply(
        "No bundled workspace dependencies are installed on this execution machine. Existing project/system tools remain available. No software was installed.",
        false,
      );
    const lines = [
      "Workspace dependencies found on the current execution machine (read-only discovery).",
      `Bundle: ${data.bundleVersion || "unknown"}`,
      `Runtime root: ${data.root}`,
    ];
    for (const [label, path] of [
      ["Node.js", data.node],
      ["Python", data.python],
      ["Node modules", data.nodeModules],
      ["Bundled document/slide/spreadsheet/PDF plugins", data.plugins],
    ])
      if (path) lines.push(`${label}: ${path}`);
    lines.push(
      "Use these absolute executable paths. Read the relevant installed plugin skill for its libraries and workflow. This lookup does not install project dependencies or run commands.",
    );
    return reply(lines.join("\n"));
  } catch {
    return reply(
      "Workspace dependency discovery failed. Retry this read-only tool after checking the machine connection; no installation or project command was performed.",
      false,
    );
  }
}
