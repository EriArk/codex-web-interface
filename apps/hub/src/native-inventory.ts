import type { NativeInventory } from "@codex-web/shared";

const obj = (v: unknown): Record<string, any> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, any>) : {};
const rows = (v: unknown): any[] => (Array.isArray(v) ? v.slice(0, 400) : []);
const label = (v: unknown, max = 120) => (typeof v === "string" ? v.slice(0, max) : "");
const directory = (v: unknown) => {
  const p = label(v, 4096).replaceAll("\\", "/").replace(/\/$/, "");
  return /^[a-z]:\//i.test(p) ? p.toLowerCase() : p;
};
export async function readNativeInventory(
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  cwd: string,
): Promise<NativeInventory["groups"]> {
  const responses = await Promise.allSettled([
    request("skills/list", { cwds: [cwd], forceReload: false }),
    request("plugin/list", { cwds: [cwd], forceRefetch: false }),
    request("mcpServerStatus/list", { limit: 100, detail: "toolsAndAuthOnly" }),
  ]);
  return responses.map((result, index) => {
    const kind = (["skills", "plugins", "mcp"] as const)[index]!;
    const data = result.status === "fulfilled" ? obj(result.value) : {};
    const available = Array.isArray(kind === "plugins" ? data.marketplaces : data.data);
    let all: NativeInventory["groups"][number]["items"];
    if (kind === "skills")
      all = rows(data.data)
        .filter((e) => directory(e.cwd) === directory(cwd))
        .flatMap((e) => rows(e.skills))
        .map((s) => ({
          name: label(s.interface?.displayName || s.name),
          description: label(s.description, 500),
          state: s.enabled === true ? "Доступен" : "Выключен",
        }));
    else if (kind === "plugins")
      all = rows(data.marketplaces)
        .flatMap((m) => rows(m.plugins))
        .filter((p) => p.installed === true)
        .map((p) => ({
          name: label(p.interface?.displayName || p.name),
          description: label(p.interface?.shortDescription, 500),
          state:
            p.availability === "DISABLED_BY_ADMIN"
              ? "Отключён администратором"
              : p.enabled === true
                ? "Включён"
                : "Выключен",
        }));
    else
      all = rows(data.data).map((s) => ({
        name: label(s.name),
        description: `${Object.keys(obj(s.tools)).length} инструментов`,
        state:
          s.runtimeStatus === "connected"
            ? "Подключён"
            : s.runtimeStatus === "failed"
              ? "Ошибка подключения"
              : s.runtimeStatus === "disabled"
                ? "Выключен"
                : s.runtimeStatus === "authenticationRequired" || s.authStatus === "notLoggedIn"
                  ? "Требуется вход"
                  : "Настроен; состояние подключения не подтверждено",
      }));
    return {
      kind,
      available,
      more: all.length > 400 || !!data.nextCursor,
      items: all.filter((i) => i.name).slice(0, 400),
    };
  });
}
