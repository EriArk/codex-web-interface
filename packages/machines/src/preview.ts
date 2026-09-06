import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { posix, win32 } from "node:path";
import { HubError, type MachineConfig } from "@codex-web/shared";
import { quotePowerShell, stopProcess } from "./index.js";

export const PREVIEW_LIMIT = 2 * 1024 * 1024;
export function previewPath(machine: MachineConfig, root: string, input: string): string {
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
    !/\.html?$/i.test(value) ||
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
  return new HubError(400, "INVALID_PREVIEW_PATH", "Нужен HTML-файл внутри папки проекта.");
}
export async function readMachinePreview(
  machine: MachineConfig,
  root: string,
  input: string,
): Promise<Buffer> {
  const path = previewPath(machine, root, input);
  if (machine.type === "local-linux") {
    const actualRoot = await realpath(root),
      actual = await realpath(path);
    const relative = posix.relative(actualRoot, actual);
    if (!relative || relative === ".." || relative.startsWith("../") || posix.isAbsolute(relative))
      throw invalid();
    const file = await open(actual, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > PREVIEW_LIMIT) throw invalid();
      const bytes = Buffer.alloc(PREVIEW_LIMIT + 1);
      let size = 0;
      while (size < bytes.length) {
        const read = await file.read(bytes, size, bytes.length - size, null);
        if (!read.bytesRead) break;
        size += read.bytesRead;
      }
      if (size > PREVIEW_LIMIT) throw invalid();
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
    "try {if($f.Length -gt 2097152){throw 'TOO_LARGE'}; $b=New-Object byte[] ([int]$f.Length); $n=0; while($n -lt $b.Length){$read=$f.Read($b,$n,$b.Length-$n); if($read -eq 0){throw 'TRUNCATED'}; $n+=$read}; [Console]::Out.Write([Convert]::ToBase64String($b))} finally {$f.Dispose()}",
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
    let out = "",
      done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stopProcess(child);
      if (ok && /^[A-Za-z0-9+/]*={0,2}$/.test(out)) resolve(Buffer.from(out, "base64"));
      else
        reject(
          new HubError(
            503,
            "PREVIEW_UNAVAILABLE",
            "Демо пока недоступно. Проверь связь и наличие HTML-файла.",
          ),
        );
    };
    const timer = setTimeout(() => finish(false), 15000);
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("ascii");
      if (out.length > Math.ceil(PREVIEW_LIMIT / 3) * 4) finish(false);
    });
    child.stderr.on("data", () => {});
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0));
    child.stdin.end();
  });
}
