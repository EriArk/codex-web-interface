import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, readdir, statfs } from "node:fs/promises";
import { createConnection } from "node:net";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { CodexClient } from "@codex-web/codex";
import { probeCodex, spawnCodex, stopProcess } from "@codex-web/machines";
import type { HubConfig, MachineConfig } from "@codex-web/shared";
import { normalizeGptConnection } from "@codex-web/shared";
import { loadConfig } from "./config.js";
import { configuredNativeGpt } from "./gpt-native-config.js";
import { NativeGptProvider } from "./gpt-native-provider.js";
import { SCHEMA_VERSION, schemaVersion } from "./migrations.js";
import { storageReport } from "./storage.js";

type State = "ok" | "warning" | "error" | "skipped";
type Check = { boundary: string; state: State; code: string };
type Rpc = Pick<CodexClient, "initialize" | "request" | "close">;
export function safeVersion(value: unknown): string | undefined {
  return typeof value === "string"
    ? /^codex(?:-cli)?\s+(\d+\.\d+\.\d+)(?:\s|$)/i.exec(value)?.[1]
    : undefined;
}
export function sshFailure(stderr: string): string {
  if (/host key verification failed|remote host identification has changed/i.test(stderr))
    return "SSH_HOST_KEY_FAILED";
  if (/permission denied|authentication failed|no supported authentication/i.test(stderr))
    return "SSH_AUTH_FAILED";
  return "SSH_UNREACHABLE";
}
export async function sshProbe(machine: MachineConfig): Promise<string> {
  if (!machine.ssh) return "SSH_NOT_CONFIGURED";
  return new Promise((resolveResult) => {
    const script = "[Console]::Out.Write('CODEX_WEB_SSH_OK')";
    const child = spawn(
      "ssh",
      [
        ...(machine.ssh?.configFile ? ["-F", machine.ssh.configFile] : []),
        "-T",
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        "ConnectTimeout=6",
        machine.ssh!.target,
        "powershell.exe",
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { stdio: "pipe", detached: process.platform !== "win32", windowsHide: true },
    );
    let output = "",
      error = "",
      done = false;
    const finish = (code: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stopProcess(child);
      resolveResult(code);
    };
    const timer = setTimeout(() => finish("SSH_TIMEOUT"), 8000);
    child.stdout.on("data", (bytes) => {
      output = (output + bytes.toString()).slice(-4096);
    });
    child.stderr.on("data", (bytes) => {
      error = (error + bytes.toString()).slice(-4096);
    });
    child.stdin.on("error", () => {});
    child.on("error", () => finish("SSH_CLIENT_UNAVAILABLE"));
    child.on("close", (code) =>
      finish(code === 0 && output.trim() === "CODEX_WEB_SSH_OK" ? "SSH_OK" : sshFailure(error)),
    );
    child.stdin.end();
  });
}
export async function tcp(host: string, port: number): Promise<boolean> {
  return new Promise((resolveResult) => {
    const socket = createConnection({ host, port });
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolveResult(ok);
    };
    socket.setTimeout(3000, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}
async function health(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(4000), redirect: "error" });
    if (!response.ok) return false;
    const text = await response.text();
    return text.length < 1000 && JSON.parse(text).ok === true;
  } catch {
    return false;
  }
}
async function usage(
  path: string,
  budget = { remaining: 100000 },
): Promise<{ bytes: number; partial: boolean }> {
  let bytes = 0,
    partial = false;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (--budget.remaining < 0) return { bytes, partial: true };
    const child = join(path, entry.name);
    if (entry.isSymbolicLink()) {
      partial = true;
      continue;
    }
    if (entry.isDirectory()) {
      const nested = await usage(child, budget);
      bytes += nested.bytes;
      partial ||= nested.partial;
    } else if (entry.isFile()) bytes += (await lstat(child)).size;
  }
  return { bytes, partial };
}
export async function collectDiagnostics(
  config: HubConfig,
  options: {
    offline?: boolean;
    publicCheck?: boolean;
    configPath?: string;
    revision?: string;
  } = {},
  dependencies: {
    ssh?: typeof sshProbe;
    codex?: typeof probeCodex;
    rpc?: (machine: MachineConfig, cwd: string) => Rpc;
    gpt?: () => Promise<unknown>;
  } = {},
) {
  const checks: Check[] = [];
  const add = (boundary: string, state: State, code: string) =>
    checks.push({ boundary, state, code });
  let gptActive = 0,
    gptUnknown = 0;
  let schema: number | undefined,
    databaseBytes = 0,
    resultsBytes = 0,
    freeBytes: number | undefined,
    sizePartial = false;
  try {
    const db = new DatabaseSync(config.hub.databasePath, { readOnly: true });
    try {
      schema = schemaVersion(db);
      if (schema >= 6)
        try {
          gptActive = Number(
            db
              .prepare(
                "SELECT count(*) AS n FROM gpt_jobs WHERE status IN ('queued','preparing','running')",
              )
              .get()?.n,
          );
          gptUnknown = Number(
            db.prepare("SELECT count(*) AS n FROM gpt_jobs WHERE status='unknown'").get()?.n,
          );
        } catch {}
      add(
        "database",
        schema === SCHEMA_VERSION ? "ok" : schema > SCHEMA_VERSION ? "error" : "warning",
        schema === SCHEMA_VERSION
          ? "SCHEMA_CURRENT"
          : schema > SCHEMA_VERSION
            ? "DB_SCHEMA_TOO_NEW"
            : "MIGRATION_PENDING",
      );
    } finally {
      db.close();
    }
    for (const suffix of ["", "-wal", "-shm"])
      try {
        databaseBytes += (await lstat(config.hub.databasePath + suffix)).size;
      } catch {}
  } catch {
    add("database", "error", "DATABASE_UNREADABLE");
  }
  try {
    const sizes = await usage(config.hub.resultsPath);
    resultsBytes = sizes.bytes;
    sizePartial = sizes.partial;
  } catch {
    add("results", "error", "RESULTS_UNREADABLE");
  }
  try {
    const disk = await statfs(dirname(config.hub.databasePath));
    freeBytes = disk.bavail * disk.bsize;
  } catch {
    add("disk", "warning", "DISK_USAGE_UNAVAILABLE");
  }
  for (const [label, path] of [
    ["database-file", config.hub.databasePath],
    ["results-directory", config.hub.resultsPath],
    ...(options.configPath ? [["configuration-file", options.configPath]] : []),
  ]) {
    if (!label || !path) continue;
    try {
      const info = await lstat(path);
      await access(path, constants.R_OK | (label === "configuration-file" ? 0 : constants.W_OK));
      add(
        label,
        info.isSymbolicLink() || (process.platform !== "win32" && (info.mode & 0o077) !== 0)
          ? "warning"
          : "ok",
        info.isSymbolicLink()
          ? "PRIVATE_PATH_SYMLINK"
          : process.platform !== "win32" && (info.mode & 0o077) !== 0
            ? "PRIVATE_PERMISSIONS_WIDE"
            : "PRIVATE_PATH_OK",
      );
    } catch {
      add(label, "error", "PRIVATE_PATH_UNAVAILABLE");
    }
  }
  if (!options.offline) {
    const host =
      config.hub.host === "0.0.0.0"
        ? "127.0.0.1"
        : config.hub.host === "::"
          ? "[::1]"
          : config.hub.host;
    add(
      "hub-http",
      (await health("http://" + host + ":" + config.hub.port + "/api/health")) ? "ok" : "error",
      "HUB_HEALTH",
    );
    if (config.machines.some((m) => m.remote))
      add("guacd", (await tcp("127.0.0.1", 4822)) ? "ok" : "error", "GUACD_TCP");
    if (options.publicCheck)
      add(
        "public-https",
        (await health(config.hub.publicBaseUrl + "/api/health")) ? "ok" : "error",
        "PUBLIC_HEALTH",
      );
  }
  let gpt = normalizeGptConnection(null, !!config.gpt || !!config.nativeGpt);
  if (config.nativeGpt && !options.offline) {
    try {
      gpt = await new NativeGptProvider(configuredNativeGpt(config, () => {})!).connection();
    } catch {}
    add("gpt", gpt.state === "healthy" ? "ok" : "warning", "GPT_NATIVE_" + gpt.state.toUpperCase());
  } else if (config.gpt && !options.offline) {
    let raw: unknown = null;
    try {
      if (dependencies.gpt) raw = await dependencies.gpt();
      else {
        const token = process.env[config.gpt.tokenSecret];
        if (token) {
          const response = await fetch(new URL("/status", config.gpt.endpoint), {
            headers: { Authorization: "Bearer " + token },
            signal: AbortSignal.timeout(15000),
            redirect: "error",
          });
          if (response.ok) raw = await response.json();
          else await response.body?.cancel();
        }
      }
    } catch {}
    gpt = normalizeGptConnection(raw);
    add(
      "gpt",
      gpt.state === "healthy" || gpt.state === "busy" ? "ok" : "warning",
      "GPT_" + gpt.state.toUpperCase(),
    );
    if (gpt.privateState)
      add(
        "gpt/private-state",
        gpt.privateState.permissions && gpt.privateState.locked ? "ok" : "warning",
        "GPT_PRIVATE_STATE_" +
          (gpt.privateState.permissions && gpt.privateState.locked ? "OK" : "CHECK"),
      );
  } else add("gpt", "skipped", config.gpt ? "NETWORK_PROBES_SKIPPED" : "GPT_DISABLED");
  gpt.activeJobs = gptActive;
  gpt.unknownJobs = gptUnknown;
  let storageDetail: Awaited<ReturnType<typeof storageReport>> | undefined;
  try {
    const db = new DatabaseSync(config.hub.databasePath, { readOnly: true });
    try {
      storageDetail = await storageReport(config, db);
    } finally {
      db.close();
    }
    if (storageDetail.partial || storageDetail.missingFiles)
      add("storage", "warning", "STORAGE_INVENTORY_NEEDS_REVIEW");
    if (storageDetail.buckets.some((bucket) => bucket.warning))
      add("storage", "warning", "STORAGE_APPROACHING_LIMIT");
  } catch {
    add("storage", "warning", "STORAGE_REPORT_UNAVAILABLE");
  }
  const machines = [];
  for (const [index, machine] of config.machines.entries()) {
    const boundary = "machine-" + (index + 1);
    const seed = config.projects.find((p) => p.enabled && p.machineId === machine.id);
    let version: string | undefined,
      projectCatalog: boolean | undefined,
      models: boolean | undefined,
      plan: boolean | undefined;
    const companion = machine.type === "ssh-windows" ? Boolean(machine.codex.launcher) : false;
    add(boundary + "/project-roots", "warning", "PROJECT_ROOTS_UNRESTRICTED");
    if (options.offline) add(boundary, "skipped", "NETWORK_PROBES_SKIPPED");
    else if (!seed) add(boundary, "error", "SEED_PROJECT_MISSING");
    else {
      const ssh =
        machine.type === "ssh-windows" ? await (dependencies.ssh ?? sshProbe)(machine) : "LOCAL";
      if (machine.type === "ssh-windows")
        add(
          boundary + "/ssh",
          ssh === "SSH_OK" ? "ok" : "error",
          [
            "SSH_OK",
            "SSH_HOST_KEY_FAILED",
            "SSH_AUTH_FAILED",
            "SSH_UNREACHABLE",
            "SSH_TIMEOUT",
            "SSH_CLIENT_UNAVAILABLE",
            "SSH_NOT_CONFIGURED",
          ].includes(ssh)
            ? ssh
            : "SSH_UNREACHABLE",
        );
      if (ssh === "SSH_OK" || ssh === "LOCAL") {
        const executable = await (dependencies.codex ?? probeCodex)(machine, seed.workingDirectory);
        version = safeVersion(executable.version);
        add(
          boundary + "/codex-executable",
          executable.available ? "ok" : "error",
          executable.available ? "CODEX_EXECUTABLE_OK" : "CODEX_EXECUTABLE_UNAVAILABLE",
        );
        if (version && version !== "0.153.4")
          add(boundary + "/tested-version", "warning", "CODEX_VERSION_NOT_RELEASE_TESTED");
        if (executable.available) {
          const rpc = dependencies.rpc
            ? dependencies.rpc(machine, seed.workingDirectory)
            : new CodexClient(spawnCodex(machine, seed.workingDirectory), 8000);
          if (rpc instanceof CodexClient) {
            rpc.on("fault", () => {});
            rpc.on("request", (request) => rpc.rejectRequest(request.id));
          }
          try {
            await rpc.initialize();
            add(
              boundary + (companion ? "/companion-stdio" : "/app-server-stdio"),
              "ok",
              "APP_SERVER_CONNECTED",
            );
            const account = await rpc.request("account/read", { refreshToken: false });
            add(
              boundary + "/codex-login",
              account.account ? "ok" : "error",
              account.account ? "CODEX_AUTHENTICATED" : "CODEX_LOGIN_REQUIRED",
            );
            for (const [method, params, label] of [
              ["project/list", { limit: 1 }, "project-catalog"],
              ["model/list", { limit: 1, includeHidden: false }, "models"],
              ["collaborationMode/list", {}, "planning"],
            ] as const) {
              try {
                const value = await rpc.request(method, params);
                const supported = Array.isArray(value.data);
                add(
                  boundary + "/" + label,
                  supported ? "ok" : "warning",
                  supported ? "CAPABILITY_AVAILABLE" : "CAPABILITY_SHAPE_UNSUPPORTED",
                );
                if (label === "project-catalog") projectCatalog = supported;
                if (label === "models") models = supported;
                if (label === "planning") plan = supported;
              } catch {
                add(boundary + "/" + label, "warning", "CAPABILITY_UNAVAILABLE");
              }
            }
          } catch {
            add(
              boundary + (companion ? "/companion-stdio" : "/app-server-stdio"),
              "error",
              companion ? "COMPANION_STDIO_UNAVAILABLE" : "APP_SERVER_PROTOCOL_UNAVAILABLE",
            );
          } finally {
            rpc.close();
          }
        }
      }
      if (machine.remote) {
        add(
          boundary + "/remote-tcp",
          (await tcp(machine.remote.host, machine.remote.port)) ? "ok" : "error",
          "REMOTE_TCP",
        );
        add(
          boundary + "/remote-secret",
          machine.remote.passwordSecret && process.env[machine.remote.passwordSecret]
            ? "ok"
            : "warning",
          machine.remote.passwordSecret && process.env[machine.remote.passwordSecret]
            ? "REMOTE_SECRET_PRESENT"
            : "REMOTE_SECRET_MISSING",
        );
      }
    }
    machines.push({
      id: boundary,
      type: machine.type,
      companionConfigured: companion,
      codexVersion: version,
      seedProjects: config.projects.filter((p) => p.machineId === machine.id && p.enabled).length,
      projectCatalog,
      models,
      plan,
    });
  }
  return {
    format: 1,
    appVersion: "0.1.0",
    revision: /^[0-9a-f]{7,40}$/.test(options.revision ?? "") ? options.revision : "unknown",
    generatedAt: new Date().toISOString(),
    publicOrigin: config.hub.publicBaseUrl,
    secureCookies: config.hub.secureCookies,
    schemaVersion: schema,
    storage: { databaseBytes, resultsBytes, sizePartial, freeBytes, detail: storageDetail },
    machines,
    gpt,
    checks,
    ok: checks.every((check) => check.state !== "error"),
  };
}
async function cli() {
  const { values } = parseArgs({
    options: {
      config: { type: "string" },
      json: { type: "boolean" },
      offline: { type: "boolean" },
      public: { type: "boolean" },
      revision: { type: "string" },
    },
  });
  if (!values.config) throw new Error("configuration-required");
  const report = await collectDiagnostics(loadConfig(values.config), {
    offline: values.offline,
    publicCheck: values.public,
    configPath: values.config,
    revision: values.revision ?? process.env.HUB_REVISION,
  });
  if (values.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(
      "Codex Web " +
        report.appVersion +
        " (" +
        report.revision +
        "), schema " +
        (report.schemaVersion ?? "unknown"),
    );
    console.log(
      "Storage: DB " +
        report.storage.databaseBytes +
        " B; results " +
        report.storage.resultsBytes +
        " B; free " +
        (report.storage.freeBytes ?? "unknown") +
        " B",
    );
    for (const machine of report.machines)
      console.log(
        machine.id + ": " + machine.type + ", Codex " + (machine.codexVersion ?? "unknown"),
      );
    for (const check of report.checks)
      console.log(check.boundary + ": " + check.state + " [" + check.code + "]");
  }
  if (!report.ok) process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void cli().catch(() => {
    console.error(JSON.stringify({ ok: false, code: "DOCTOR_CONFIG_OR_PROBE_FAILED" }));
    process.exitCode = 1;
  });
}
