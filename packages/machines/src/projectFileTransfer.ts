import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import { open, realpath, rm } from "node:fs/promises";
import { posix, win32 } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { HubError, type MachineConfig } from "@codex-web/shared";
import { quotePowerShell, stopProcess } from "./index.js";
import { codexArtifactPath, projectFilePath } from "./projectFile.js";
import { verifyProjectRoot } from "./projectRoots.js";

export const ARTIFACT_FILE_LIMIT = 512 * 1024 * 1024;
// Only this fixed, root-checked read is sent through system SSH. Neither endpoint
// buffers the file; the sender's checksum also detects truncated transfers.
export function projectTransferScript(root: string, path: string, limit: number) {
  return [
    "$ErrorActionPreference='Stop'",
    "$ProgressPreference='SilentlyContinue'",
    "$root=[IO.Path]::GetFullPath(" + quotePowerShell(root) + ").TrimEnd([char]92)",
    "$path=[IO.Path]::GetFullPath(" + quotePowerShell(path) + ")",
    "if(-not $path.StartsWith($root+[char]92,[StringComparison]::OrdinalIgnoreCase)){throw 'OUTSIDE_PROJECT'}",
    "$check=$path; while($check){if(([IO.File]::GetAttributes($check) -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'REPARSE_POINT'}; $check=[IO.Path]::GetDirectoryName($check)}",
    "$f=[IO.File]::Open($path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)",
    "$sha=[Security.Cryptography.SHA256]::Create()",
    `try {if($f.Length -gt ${limit}){throw 'TOO_LARGE'}; $length=$f.Length; $b=New-Object byte[] 262144; $out=[Console]::OpenStandardOutput(); $n=0; while(($read=$f.Read($b,0,$b.Length)) -gt 0){$n+=$read; if($n -gt ${limit}){throw 'TOO_LARGE'}; [void]$sha.TransformBlock($b,0,$read,$b,0); $out.Write($b,0,$read)}; [void]$sha.TransformFinalBlock($b,0,0); if($n -ne $length){throw 'CHANGED'}; $hash=([BitConverter]::ToString($sha.Hash)).Replace('-','').ToLowerInvariant(); [Console]::Error.WriteLine('CWFILE '+$n+' '+$hash)} finally {$f.Dispose(); $sha.Dispose()}`,
  ].join("; ");
}

export async function copyProjectFile(
  machine: MachineConfig,
  root: string,
  input: string,
  destination: string,
  limit = ARTIFACT_FILE_LIMIT,
): Promise<{ bytes: number; sha256: string }> {
  return transferFile(machine, root, input, destination, limit, false);
}

export async function copyCodexArtifact(
  machine: MachineConfig,
  root: string,
  input: string,
  destination: string,
  limit = ARTIFACT_FILE_LIMIT,
) {
  return transferFile(machine, root, input, destination, limit, true);
}

async function transferFile(
  machine: MachineConfig,
  root: string,
  input: string,
  destination: string,
  limit: number,
  nativeLink: boolean,
) {
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > ARTIFACT_FILE_LIMIT)
    throw new Error("INVALID_TRANSFER_LIMIT");
  await verifyProjectRoot(machine, root);
  const path = nativeLink
    ? codexArtifactPath(machine, root, input)
    : projectFilePath(machine, root, input);
  if (nativeLink) root = (machine.type === "local-linux" ? posix : win32).dirname(path);
  const hash = createHash("sha256");
  let bytes = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > limit)
        callback(
          new HubError(
            413,
            "ARTIFACT_TOO_LARGE",
            "Файл превышает допустимый размер или свободное место в хранилище.",
          ),
        );
      else {
        hash.update(chunk);
        callback(null, chunk);
      }
    },
  });
  const output = () => createWriteStream(destination, { flags: "wx", mode: 0o600 });
  try {
    if (machine.type === "local-linux") {
      const actualRoot = await realpath(root),
        actual = await realpath(path);
      const relative = posix.relative(actualRoot, actual);
      if (
        (nativeLink && (actualRoot !== root || actual !== path)) ||
        !relative ||
        relative === ".." ||
        relative.startsWith("../") ||
        posix.isAbsolute(relative)
      )
        throw new HubError(400, "INVALID_PROJECT_FILE", "Нужен файл внутри папки проекта.");
      const file = await open(actual, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const before = await file.stat();
        if (!before.isFile()) throw new Error("NOT_A_FILE");
        if (before.size > limit)
          throw new HubError(
            413,
            "ARTIFACT_TOO_LARGE",
            "Файл больше 512 МБ или не помещается в хранилище.",
          );
        await pipeline(file.createReadStream({ autoClose: false }), meter, output(), {
          signal: AbortSignal.timeout(600000),
        });
        const after = await file.stat();
        if (
          bytes !== before.size ||
          before.size !== after.size ||
          before.mtimeMs !== after.mtimeMs ||
          before.ctimeMs !== after.ctimeMs
        )
          throw new Error("FILE_CHANGED");
      } finally {
        await file.close();
      }
      return { bytes, sha256: hash.digest("hex") };
    }
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
        Buffer.from(projectTransferScript(root, path, limit), "utf16le").toString("base64"),
      ],
      { stdio: "pipe", detached: process.platform !== "win32", windowsHide: true },
    );
    let diagnostic = "";
    child.stderr.on("data", (chunk: Buffer) => {
      diagnostic = (diagnostic + chunk.toString()).slice(-4096);
    });
    const closed = new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      stopProcess(child);
    }, 600000);
    child.stdin.end();
    try {
      await Promise.all([
        pipeline(child.stdout, meter, output(), { signal: controller.signal }),
        closed.then((code) => {
          if (code !== 0) throw new Error("TRANSFER_FAILED");
        }),
      ]);
      const digest = hash.digest("hex"),
        receipt = diagnostic.match(/(?:^|\r?\n)CWFILE (\d+) ([a-f0-9]{64})(?:\r?\n|$)/);
      if (!receipt || Number(receipt[1]) !== bytes || receipt[2] !== digest)
        throw new Error("TRANSFER_MISMATCH");
      return { bytes, sha256: digest };
    } finally {
      clearTimeout(timer);
      controller.abort();
      stopProcess(child);
      await closed.catch(() => {});
    }
  } catch (error) {
    await rm(destination, { force: true });
    if (error instanceof HubError) throw error;
    throw new HubError(
      503,
      "PROJECT_FILE_UNAVAILABLE",
      "Файл недоступен, изменился при переносе или превышает 512 МБ. Проверь файл и подключение к компьютеру.",
    );
  }
}
