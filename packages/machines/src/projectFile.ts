import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { posix, win32 } from "node:path";
import { HubError, type MachineConfig } from "@codex-web/shared";
import { quotePowerShell, stopProcess } from "./index.js";
import { assertProjectRoot, verifyProjectRoot } from "./projectRoots.js";

export const PROJECT_FILE_LIMIT = 32 * 1024 * 1024;
export function projectFilePath(machine: MachineConfig, root: string, input: string): string {
  assertProjectRoot(machine, root);
  const paths = machine.type === "local-linux" ? posix : win32;
  let value: string;
  try {
    value = decodeURIComponent(input);
  } catch {
    throw invalid();
  }
  if (value.startsWith("/") && /^\/[a-z]:[\\/]/i.test(value)) value = value.slice(1);
  if (
    /[\0\r\n]/.test(value) ||
    !paths.isAbsolute(root) ||
    (machine.type !== "local-linux" && (/^\\\\/.test(value) || /:/.test(value.slice(2))))
  )
    throw invalid();
  const full = paths.resolve(root, value);
  const relative = paths.relative(paths.resolve(root), full);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(".." + paths.sep) ||
    paths.isAbsolute(relative)
  )
    throw invalid();
  return full;
}
function invalid() {
  return new HubError(400, "INVALID_PROJECT_FILE", "Нужен файл внутри папки проекта.");
}
export async function readProjectFile(
  machine: MachineConfig,
  root: string,
  input: string,
  options: { rejectSymlinks?: boolean } = {},
): Promise<Buffer> {
  await verifyProjectRoot(machine, root);
  const path = projectFilePath(machine, root, input);
  if (machine.type === "local-linux") {
    const actualRoot = await realpath(root),
      actual = await realpath(path);
    if (options.rejectSymlinks && (actualRoot !== posix.resolve(root) || actual !== path))
      throw invalid();
    const relative = posix.relative(actualRoot, actual);
    if (!relative || relative === ".." || relative.startsWith("../") || posix.isAbsolute(relative))
      throw invalid();
    const file = await open(actual, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > PROJECT_FILE_LIMIT) throw invalid();
      const bytes = Buffer.alloc(Math.min(stat.size + 1, PROJECT_FILE_LIMIT + 1));
      let size = 0;
      while (size < bytes.length) {
        const read = await file.read(bytes, size, bytes.length - size, null);
        if (!read.bytesRead) break;
        size += read.bytesRead;
      }
      const after = await file.stat();
      if (size > PROJECT_FILE_LIMIT || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs)
        throw invalid();
      return bytes.subarray(0, size);
    } finally {
      await file.close();
    }
  }
  const script = [
    "$ErrorActionPreference='Stop'",
    "$root=[IO.Path]::GetFullPath(" + quotePowerShell(root) + ").TrimEnd([char]92)",
    "$path=[IO.Path]::GetFullPath(" + quotePowerShell(path) + ")",
    "if(-not $path.StartsWith($root+[char]92,[StringComparison]::OrdinalIgnoreCase)){throw 'OUTSIDE_PROJECT'}",
    // Reject junctions and symlinks all the way to the volume, including the configured root.
    "$check=$path; while($check){if(([IO.File]::GetAttributes($check) -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'REPARSE_POINT'}; $check=[IO.Path]::GetDirectoryName($check)}",
    "$f=[IO.File]::Open($path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)",
    "try {if($f.Length -gt 33554432){throw 'TOO_LARGE'}; $b=New-Object byte[] ([int]$f.Length); $n=0; while($n -lt $b.Length){$read=$f.Read($b,$n,$b.Length-$n); if($read -eq 0){throw 'TRUNCATED'}; $n+=$read}; [Console]::OpenStandardOutput().Write($b,0,$b.Length)} finally {$f.Dispose()}",
  ].join("; ");
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
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0,
      done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stopProcess(child);
      if (ok) resolve(Buffer.concat(chunks, size));
      else
        reject(
          new HubError(
            503,
            "PROJECT_FILE_UNAVAILABLE",
            "Файл недоступен или превышает 32 МБ. Проверь связь и наличие файла.",
          ),
        );
    };
    const timer = setTimeout(() => finish(false), 30000);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > PROJECT_FILE_LIMIT) finish(false);
      else chunks.push(chunk);
    });
    child.stderr.on("data", () => {});
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0));
    child.stdin.end();
  });
}
