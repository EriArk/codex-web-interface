import { readFileSync } from "node:fs";
import { configSchema, type HubConfig } from "@codex-web/shared";
import { parse } from "yaml";
export function loadConfig(path: string): HubConfig {
  return configSchema.parse(parse(readFileSync(path, "utf8"), { maxAliasCount: 0 }));
}
