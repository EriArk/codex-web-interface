import type { CodexClient } from "@codex-web/codex";
import { HubError } from "@codex-web/shared";
export type AccessMode = "workspace" | "full";
export async function accessCapabilities(
  rpc: Pick<CodexClient, "request">,
  cwd: string,
): Promise<{ modes: AccessMode[]; message?: string }> {
  try {
    let cursor: string | undefined,
      allowed = false;
    for (let n = 0; n < 10; n++) {
      const page = await rpc.request("permissionProfile/list", {
        cwd,
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      if (!Array.isArray(page.data)) throw Error("Invalid profiles");
      allowed ||= page.data.some(
        (p: unknown) =>
          !!p &&
          typeof p === "object" &&
          "id" in p &&
          p.id === ":danger-full-access" &&
          "allowed" in p &&
          p.allowed === true,
      );
      if (!page.nextCursor) break;
      if (typeof page.nextCursor !== "string" || page.nextCursor === cursor)
        throw Error("Invalid cursor");
      cursor = page.nextCursor;
    }
    const response = await rpc.request("configRequirements/read", {});
    if (!("requirements" in response)) throw Error("Unknown requirements");
    const requirements = response.requirements as { allowedApprovalPolicies?: unknown } | null;
    if (
      requirements?.allowedApprovalPolicies !== undefined &&
      (!Array.isArray(requirements.allowedApprovalPolicies) ||
        !requirements.allowedApprovalPolicies.includes("never"))
    )
      allowed = false;
    return {
      modes: allowed ? ["workspace", "full"] : ["workspace"],
      ...(!allowed ? { message: "Полный доступ запрещён настройками Codex." } : {}),
    };
  } catch {
    return { modes: ["workspace"], message: "Codex пока не подтвердил поддержку полного доступа." };
  }
}
export async function requireAccess(
  rpc: Pick<CodexClient, "request">,
  cwd: string,
  mode?: AccessMode,
) {
  if (mode === "full" && !(await accessCapabilities(rpc, cwd)).modes.includes("full"))
    throw new HubError(
      403,
      "ACCESS_UNAVAILABLE",
      "Полный доступ недоступен в текущей конфигурации Codex.",
    );
}
export const threadAccess = (mode?: AccessMode) =>
  mode === "full"
    ? { permissions: ":danger-full-access", approvalPolicy: "never" }
    : { sandbox: "workspace-write", approvalPolicy: "on-request" };
export const turnAccess = (mode?: AccessMode) =>
  mode === "full"
    ? { permissions: ":danger-full-access", approvalPolicy: "never" }
    : {
        sandboxPolicy: { type: "workspaceWrite", networkAccess: false },
        approvalPolicy: "on-request",
      };
