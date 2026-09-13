import { spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { posix, win32 } from "node:path";
import { HubError, type MachineConfig } from "@codex-web/shared";
import { authorizeMachine } from "./authority.js";
import { quotePowerShell, stopProcess } from "./index.js";

const denied = () =>
  new HubError(
    403,
    "PROJECT_ROOT_DENIED",
    "Папка вне разрешённых корней компьютера или содержит ссылку. Измени корни через настройку подключения на самом ПК.",
  );
export function normalizedProjectPath(machine: Pick<MachineConfig, "type">, value: string) {
  if (
    !value ||
    value.length > 2048 ||
    Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  )
    throw denied();
  if (machine.type === "local-linux") {
    if (!value.startsWith("/")) throw denied();
    return posix.resolve(value);
  }
  const path = value.replaceAll("/", "\\");
  if (!/^(?:[A-Za-z]:\\|\\\\[^\\]+\\[^\\]+(?:\\|$))/.test(path) || /^\\\\[?.]\\/.test(path))
    throw denied();
  const parts = path.replace(/^[A-Za-z]:/, "").split("\\");
  if (
    parts.some(
      (part) =>
        /[:*?"<>|]/.test(part) ||
        (part !== "." && part !== ".." && /[. ]$/.test(part)) ||
        /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part),
    )
  )
    throw denied();
  return win32.normalize(path);
}
export function projectPathAllowed(
  machine: Pick<MachineConfig, "type" | "allowedProjectRoots">,
  path: string,
) {
  try {
    assertProjectRoot(machine, path);
    return true;
  } catch {
    return false;
  }
}
export function assertProjectRoot(
  machine: Pick<MachineConfig, "type" | "allowedProjectRoots">,
  path: string,
) {
  // Preserve the admitted owner's existing unrestricted folder workflow until enrollment.
  if (machine.allowedProjectRoots === undefined) return path;
  const normalized = normalizedProjectPath(machine, path),
    paths = machine.type === "local-linux" ? posix : win32;
  if (
    !machine.allowedProjectRoots.some((root) => {
      const relative = paths.relative(normalizedProjectPath(machine, root), normalized);
      return (
        relative !== ".." && !relative.startsWith(".." + paths.sep) && !paths.isAbsolute(relative)
      );
    })
  )
    throw denied();
  return normalized;
}

export function windowsProjectRootScript(value: string, allowMissing = false) {
  const path = normalizedProjectPath({ type: "ssh-windows" }, value);
  return [
    "$ErrorActionPreference='Stop'",
    `$check=[IO.Path]::GetFullPath(${quotePowerShell(path)})`,
    `$missing=${allowMissing ? "$true" : "$false"}; $found=$false`,
    "while($check){if(Test-Path -LiteralPath $check){$attributes=[IO.File]::GetAttributes($check); if(($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or ($attributes -band [IO.FileAttributes]::Directory) -eq 0){throw 'ROOT_DENIED'}; $found=$true} elseif(-not $missing -or $found){throw 'ROOT_MISSING'}; if($check.TrimEnd([char]92) -eq [IO.Path]::GetPathRoot($check).TrimEnd([char]92)){break}; $check=[IO.Path]::GetDirectoryName($check.TrimEnd([char]92))}",
    "[Console]::Write('ROOT_OK')",
  ].join("; ");
}

/** Reject links/reparse points including the configured root, not only its descendants. */
export async function verifyProjectRoot(
  machine: MachineConfig,
  value: string,
  allowMissing = false,
) {
  authorizeMachine(machine);
  if (machine.allowedProjectRoots === undefined) return;
  const path = assertProjectRoot(machine, value);
  if (machine.type === "local-linux") {
    let current = path,
      found = false;
    while (true) {
      try {
        const stat = await lstat(current);
        if (stat.isSymbolicLink() || !stat.isDirectory() || (await realpath(current)) !== current)
          throw denied();
        found = true;
      } catch (error) {
        if (!allowMissing || found || (error as NodeJS.ErrnoException).code !== "ENOENT")
          throw error;
      }
      const parent = posix.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    return;
  }
  if (!machine.ssh) throw denied();
  const script = windowsProjectRootScript(path, allowMissing);
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
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    { stdio: "pipe", detached: process.platform !== "win32", windowsHide: true },
  );
  await new Promise<void>((resolve, reject) => {
    let output = "",
      done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stopProcess(child);
      if (ok) resolve();
      else reject(denied());
    };
    const timer = setTimeout(() => finish(false), 12000);
    child.stdout.on("data", (data: Buffer) => {
      output += data.toString("utf8");
      if (output.length > 100) finish(false);
    });
    child.stderr.on("data", () => {});
    child.on("error", () => finish(false));
    child.stdin.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0 && output.trim() === "ROOT_OK"));
    child.stdin.end();
  });
}
