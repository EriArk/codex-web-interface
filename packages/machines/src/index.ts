import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { HubError, type MachineConfig } from "@codex-web/shared";

export { type NativeActivity, readNativeActivity } from "./activity.js";
export { controlDesktop, type DesktopState, desktopError } from "./desktop.js";
export { readMachineImage } from "./image.js";

export function quotePowerShell(value: string): string {
  if (Array.from(value).some((c) => [0, 10, 13].includes(c.charCodeAt(0))))
    throw new HubError(
      400,
      "INVALID_COMMAND_VALUE",
      "Command configuration contains a control character",
    );
  return `'${value.replaceAll("'", "''")}'`;
}
export function windowsScript(
  machine: MachineConfig,
  cwd: string,
  args: readonly string[],
): string {
  if (machine.codex.launcher && args[0] === "app-server") {
    return (
      "$utf8 = [System.Text.UTF8Encoding]::new($false); [Console]::InputEncoding = $utf8; [Console]::OutputEncoding = $utf8; $OutputEncoding = $utf8; & " +
      quotePowerShell(machine.codex.launcher) +
      " --client " +
      quotePowerShell(Buffer.from(cwd, "utf8").toString("base64")) +
      "; exit $LASTEXITCODE"
    );
  }
  const command = machine.codex.command;
  const resolve =
    command === "auto"
      ? "$candidates = @(where.exe codex 2>$null); if ($LASTEXITCODE -ne 0) { throw 'CODEX_NOT_FOUND' }; $exe = $candidates | Where-Object { $_ -match '\\.(exe|cmd)$' } | Select-Object -First 1; if (-not $exe) { throw 'CODEX_NOT_FOUND' }"
      : `$exe = ${quotePowerShell(command)}`;
  return [
    "$ErrorActionPreference = 'Stop'",
    "$utf8 = [System.Text.UTF8Encoding]::new($false)",
    "[Console]::InputEncoding = $utf8",
    "[Console]::OutputEncoding = $utf8",
    "$OutputEncoding = $utf8",
    `Set-Location -LiteralPath ${quotePowerShell(cwd)}`,
    resolve,
    `& $exe ${args.map(quotePowerShell).join(" ")}`,
    "exit $LASTEXITCODE",
  ].join("; ");
}
export function spawnCodex(
  machine: MachineConfig,
  cwd: string,
  args: readonly string[] = ["app-server", "--listen", "stdio://"],
): ChildProcessWithoutNullStreams {
  const options = {
    stdio: "pipe" as const,
    detached: process.platform !== "win32",
    windowsHide: true,
  };
  if (machine.type === "local-linux")
    return spawn(machine.codex.command, [...args], { ...options, cwd });
  if (!machine.ssh) throw new HubError(503, "SSH_NOT_CONFIGURED", "SSH target is not configured");
  const sshArgs = [
    ...(machine.ssh.configFile ? ["-F", machine.ssh.configFile] : []),
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "ConnectTimeout=8",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    machine.ssh.target,
    machine.codex.shell === "pwsh" ? "pwsh.exe" : "powershell.exe",
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    Buffer.from(windowsScript(machine, cwd, args), "utf16le").toString("base64"),
  ];
  return spawn("ssh", sshArgs, options);
}
export function stopProcess(child: ChildProcessWithoutNullStreams): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.stdin.end();
  const signal = (name: NodeJS.Signals) => {
    try {
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, name);
      else child.kill(name);
    } catch {
      /* Process already exited. */
    }
  };
  signal("SIGTERM");
  const timer = setTimeout(() => signal("SIGKILL"), 3000);
  timer.unref();
  child.once("close", () => clearTimeout(timer));
}
export async function probeCodex(
  machine: MachineConfig,
  cwd: string,
): Promise<{ available: boolean; version?: string; code?: string }> {
  return new Promise((resolve) => {
    let done = false;
    let output = "";
    const child = spawnCodex(machine, cwd, ["--version"]);
    const finish = (value: { available: boolean; version?: string; code?: string }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stopProcess(child);
      resolve(value);
    };
    const timer = setTimeout(() => finish({ available: false, code: "PROBE_TIMEOUT" }), 12000);
    child.stdout.on("data", (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-4096);
    });
    child.stderr.on("data", () => {});
    child.once("error", () => finish({ available: false, code: "PROCESS_START_FAILED" }));
    child.once("close", (code) =>
      finish(
        code === 0 && /codex/i.test(output)
          ? { available: true, version: output.trim().slice(0, 150) }
          : { available: false, code: "CODEX_UNAVAILABLE" },
      ),
    );
  });
}

/** Copies only an uploaded blob into a generated private location. Never executes its contents. */
export async function stageAttachment(
  machine: MachineConfig,
  projectId: string,
  id: string,
  name: string,
  sourcePath: string,
): Promise<string> {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(projectId) || !/^[0-9a-f-]{36}$/.test(id))
    throw new HubError(400, "INVALID_ATTACHMENT", "Invalid attachment identifier");
  const { readFile, mkdir, copyFile, chmod } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const safeName =
    name
      .normalize("NFC")
      .replace(/[^a-zA-Z0-9а-яА-ЯёЁ._ -]/gu, "_")
      .slice(-120)
      .replace(/[. ]+$/, "") || "attachment";
  if (machine.type === "local-linux") {
    const { dirname } = await import("node:path");
    const dir = join(dirname(sourcePath), "staged", projectId, id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, `upload-${safeName}`);
    await copyFile(sourcePath, path);
    await chmod(path, 0o600);
    return path;
  }
  if (!machine.ssh) throw new HubError(503, "SSH_NOT_CONFIGURED", "SSH target is not configured");
  const bytes = await readFile(sourcePath);
  const encoded = bytes.toString("base64");
  const script = [
    "$ErrorActionPreference='Stop'",
    "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)",
    "$dir=Join-Path $env:LOCALAPPDATA " +
      quotePowerShell(`CodexWeb\\attachments\\${projectId}\\${id}`),
    "[IO.Directory]::CreateDirectory($dir) | Out-Null",
    `$path=Join-Path $dir ${quotePowerShell(`upload-${safeName}`)}`,
    // Windows OpenSSH may keep stdin open after the client sends EOF. Frame the payload explicitly.
    "$encoded=[Console]::In.ReadLine()",
    `if ($null -eq $encoded -or $encoded.Length -ne ${encoded.length}) { throw 'INCOMPLETE_UPLOAD' }`,
    "$bytes=[Convert]::FromBase64String($encoded)",
    "[IO.File]::WriteAllBytes($path,$bytes)",
    "[Console]::Out.Write($path)",
  ].join("; ");
  return new Promise((resolve, reject) => {
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
        "ConnectTimeout=8",
        machine.ssh?.target ?? "",
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
      done = false;
    const finish = (error?: HubError) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (error) {
        stopProcess(child);
        reject(error);
      } else resolve(output.trim());
    };
    const timer = setTimeout(
      () =>
        finish(
          new HubError(
            504,
            "UPLOAD_TRANSFER_TIMEOUT",
            "Не удалось передать вложение на компьютер вовремя",
          ),
        ),
      60000,
    );
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > 4096)
        finish(
          new HubError(502, "INVALID_TRANSFER_RESPONSE", "Некорректный ответ при передаче файла"),
        );
    });
    child.stderr.on("data", () => {});
    child.once("error", () =>
      finish(
        new HubError(
          503,
          "UPLOAD_TRANSFER_FAILED",
          "Не удалось подключиться к компьютеру для передачи файла",
        ),
      ),
    );
    child.stdin.on("error", () =>
      finish(new HubError(503, "UPLOAD_TRANSFER_FAILED", "Передача файла прервалась")),
    );
    child.once("close", (code) =>
      finish(
        code === 0 && /^[A-Za-z]:\\/.test(output.trim())
          ? undefined
          : new HubError(
              503,
              "UPLOAD_TRANSFER_FAILED",
              "Не удалось сохранить вложение на компьютере",
            ),
      ),
    );
    child.stdin.end(encoded + "\n");
  });
}
