import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { HubError, type MachineConfig } from "@codex-web/shared";
import { authorizeMachine } from "./authority.js";
import { stopProcess } from "./index.js";

export interface WorkspaceDependencies {
  installed: boolean;
  bundleVersion?: string;
  root?: string;
  node?: string;
  python?: string;
  nodeModules?: string;
  plugins?: string;
}
const unavailable = () =>
  new HubError(
    503,
    "WORKSPACE_DEPENDENCIES_UNAVAILABLE",
    "Не удалось прочитать окружение для документов на компьютере.",
  );

// No caller paths, commands, downloads or installation. Only the existing runtime manifest.
export function workspaceDependenciesScript(): string {
  return [
    "$ErrorActionPreference='Stop'",
    "$root=Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime'",
    "$manifest=Join-Path $root 'runtime.json'",
    "if(-not [IO.File]::Exists($manifest)){[Console]::Out.Write('{\"installed\":false}'); exit 0}",
    "if((Get-Item -LiteralPath $manifest).Length -gt 65536){throw 'INVALID_MANIFEST'}",
    "$m=[IO.File]::ReadAllText($manifest) | ConvertFrom-Json",
    "$out=@{installed=$true;root=$root;bundleVersion=[string]$m.bundleVersion}",
    "$paths=@{node='dependencies/node/bin/node.exe';python='dependencies/python/python.exe';nodeModules='dependencies/node/node_modules';plugins='plugins/openai-primary-runtime'}",
    "foreach($key in $paths.Keys){$p=Join-Path $root $paths[$key];if(Test-Path -LiteralPath $p){$out[$key]=$p}}",
    "$json=$out | ConvertTo-Json -Compress; [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json)))",
  ].join("; ");
}
export async function readWorkspaceDependencies(
  machine: MachineConfig,
): Promise<WorkspaceDependencies> {
  authorizeMachine(machine);
  if (machine.type === "local-linux") {
    const root = join(homedir(), ".cache/codex-runtimes/codex-primary-runtime");
    let manifest: Record<string, unknown>;
    try {
      const path = join(root, "runtime.json");
      if ((await stat(path)).size > 65536) throw unavailable();
      manifest = JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { installed: false };
      throw unavailable();
    }
    const out: WorkspaceDependencies = {
      installed: true,
      root,
      bundleVersion: String(manifest.bundleVersion || "").slice(0, 100),
    };
    for (const [key, path] of Object.entries({
      node: "dependencies/node/bin/node",
      python: "dependencies/python/bin/python3",
      nodeModules: "dependencies/node/node_modules",
      plugins: "plugins/openai-primary-runtime",
    })) {
      const full = join(root, path);
      if (
        await stat(full).then(
          () => true,
          () => false,
        )
      )
        (out as unknown as Record<string, unknown>)[key] = full;
    }
    return out;
  }
  if (!machine.ssh) throw unavailable();
  const child = spawn(
    "ssh",
    [
      ...(machine.ssh.configFile ? ["-F", machine.ssh.configFile] : []),
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      "ConnectTimeout=8",
      machine.ssh.target,
      "powershell.exe",
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(workspaceDependenciesScript(), "utf16le").toString("base64"),
    ],
    { stdio: "pipe", detached: process.platform !== "win32", windowsHide: true },
  );
  return new Promise((resolve, reject) => {
    let output = "",
      done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stopProcess(child);
      try {
        if (!ok) throw unavailable();
        const value = JSON.parse(
          output === '{"installed":false}'
            ? output
            : Buffer.from(output, "base64").toString("utf8"),
        );
        if (typeof value.installed !== "boolean") throw unavailable();
        const result: WorkspaceDependencies = { installed: value.installed };
        for (const k of [
          "root",
          "bundleVersion",
          "node",
          "python",
          "nodeModules",
          "plugins",
        ] as const)
          if (typeof value[k] === "string" && value[k].length <= 2048 && !/[\0\r\n]/.test(value[k]))
            result[k] = value[k];
        resolve(result);
      } catch {
        reject(unavailable());
      }
    };
    const timer = setTimeout(() => finish(false), 15000);
    child.stdout.on("data", (b: Buffer) => {
      output += b.toString("ascii");
      if (output.length > 32768) finish(false);
    });
    child.stderr.on("data", () => {});
    child.once("error", () => finish(false));
    child.once("close", (code) => finish(code === 0));
    child.stdin.end();
  });
}
