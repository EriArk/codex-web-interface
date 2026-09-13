import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { HubError, type MachineConfig } from "@codex-web/shared";
import { authorizeMachine } from "./authority.js";
import { quotePowerShell, stopProcess } from "./index.js";

const transferError = (timeout = false) =>
  new HubError(
    503,
    timeout ? "UPLOAD_TRANSFER_TIMEOUT" : "UPLOAD_TRANSFER_FAILED",
    timeout
      ? "Не успели передать вложение на компьютер. Сообщение не отправлено; текст и файлы сохранены. Попробуй снова."
      : "Не удалось передать вложение на компьютер. Сообщение не отправлено; текст и файлы сохранены. Попробуй снова.",
  );

/** SFTP batch arguments are data, including quotes, backslashes and non-ASCII names. */
export function quoteSftpPath(path: string): string {
  if (
    Array.from(path).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new HubError(400, "INVALID_ATTACHMENT_PATH", "Некорректный путь вложения");
  return '"' + path.replaceAll("\\", "\\\\").replaceAll('"', '\\"') + '"';
}

async function command(
  machine: MachineConfig,
  binary: string,
  args: string[],
  input: string,
  deadline: number,
): Promise<string> {
  authorizeMachine(machine);
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw transferError(true);
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      stdio: "pipe",
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    let output = "";
    let done = false;
    const finish = (error?: HubError) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (error) {
        stopProcess(child);
        reject(error);
      } else resolve(output.trim());
    };
    const timer = setTimeout(() => finish(transferError(true)), remaining);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      if (output.length > 8192) finish(transferError());
    });
    // Neither native diagnostics nor private paths are returned to the browser/logs.
    child.stderr.on("data", () => {});
    child.once("error", () => finish(transferError()));
    child.stdin.on("error", () => finish(transferError()));
    child.once("close", (code) => finish(code === 0 ? undefined : transferError()));
    child.stdin.end(input);
  });
}

/** Copy bytes through the SSH file-transfer subsystem, never PowerShell's console input. */
export async function transferWindowsAttachment(
  machine: MachineConfig,
  projectId: string,
  id: string,
  safeName: string,
  sourcePath: string,
  deadline: number,
): Promise<string> {
  authorizeMachine(machine);
  if (!machine.ssh) throw new HubError(503, "SSH_NOT_CONFIGURED", "SSH target is not configured");
  const ssh = machine.ssh;
  const source = resolve(sourcePath);
  const info = await stat(source);
  if (!info.isFile() || info.size < 1 || info.size > 25 * 1024 * 1024)
    throw new HubError(413, "FILE_TOO_LARGE", "Размер вложения — до 25 МБ");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(source)) hash.update(chunk);
  const digest = hash.digest("hex");
  const options = [
    ...(machine.ssh.configFile ? ["-F", machine.ssh.configFile] : []),
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "ConnectTimeout=8",
    "-o",
    "ServerAliveInterval=5",
    "-o",
    "ServerAliveCountMax=2",
  ];
  const ps = (script: string, until = deadline) =>
    command(
      machine,
      "ssh",
      [
        ...options,
        "-T",
        ssh.target,
        "powershell.exe",
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(
          "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); " +
            script,
          "utf16le",
        ).toString("base64"),
      ],
      "",
      until,
    );
  const directory = `CodexWeb\\attachments\\${projectId}\\${id}`;
  const temporaryName = ".upload-" + randomUUID() + ".part";
  const prepared = await ps(
    [
      "$dir=[IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA " +
        quotePowerShell(directory) +
        "))",
      "[IO.Directory]::CreateDirectory($dir) | Out-Null",
      "$path=Join-Path $dir " + quotePowerShell("upload-" + safeName),
      "$temporary=Join-Path $dir " + quotePowerShell(temporaryName),
      "[Console]::Out.Write((@{path=$path;temporary=$temporary} | ConvertTo-Json -Compress))",
    ].join("; "),
  );
  let paths: { path: string; temporary: string };
  try {
    paths = JSON.parse(prepared);
    const suffix = "\\" + directory + "\\";
    if (
      typeof paths.path !== "string" ||
      typeof paths.temporary !== "string" ||
      !/^[A-Za-z]:\\/.test(paths.path) ||
      !/^[A-Za-z]:\\/.test(paths.temporary) ||
      !paths.path.endsWith(suffix + "upload-" + safeName) ||
      paths.temporary !== paths.path.slice(0, -("upload-" + safeName).length) + temporaryName
    )
      throw new Error("Unexpected destination");
  } catch {
    throw transferError();
  }
  try {
    // Windows OpenSSH SFTP requires /C:/... for an absolute drive path.
    const remote = "/" + paths.temporary.replaceAll("\\", "/");
    await command(
      machine,
      "sftp",
      [...options, "-b", "-", machine.ssh.target],
      "put " + quoteSftpPath(source) + " " + quoteSftpPath(remote) + "\n",
      deadline,
    );
    const acknowledgement = await ps(
      [
        "$temporary=" + quotePowerShell(paths.temporary),
        "$path=" + quotePowerShell(paths.path),
        "$length=(Get-Item -LiteralPath $temporary).Length",
        "$hash=(Get-FileHash -LiteralPath $temporary -Algorithm SHA256).Hash.ToLowerInvariant()",
        `if ($length -ne ${info.size} -or $hash -ne '${digest}') { throw 'UPLOAD_INTEGRITY_FAILED' }`,
        "Move-Item -LiteralPath $temporary -Destination $path -Force",
        "[Console]::Out.Write((@{path=$path;bytes=$length;sha256=$hash} | ConvertTo-Json -Compress))",
      ].join("; "),
    );
    const received = JSON.parse(acknowledgement);
    if (received.path !== paths.path || received.bytes !== info.size || received.sha256 !== digest)
      throw transferError();
    return paths.path;
  } catch (error) {
    await ps(
      "if ([IO.File]::Exists(" +
        quotePowerShell(paths.temporary) +
        ")) { [IO.File]::Delete(" +
        quotePowerShell(paths.temporary) +
        ") }",
      Date.now() + 2000,
    ).catch(() => {});
    throw error instanceof HubError ? error : transferError();
  }
}
