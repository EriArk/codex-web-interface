import { spawn } from "node:child_process";
import { open } from "node:fs/promises";
import { HubError, type MachineConfig } from "@codex-web/shared";
import { authorizeMachine } from "./authority.js";
import { quotePowerShell, stopProcess } from "./index.js";

const limit = 8 * 1024 * 1024;
export async function readMachineImage(machine: MachineConfig, path: string): Promise<Buffer> {
  authorizeMachine(machine);
  // Native Markdown/file URLs may preserve the leading slash before a Windows
  // drive. Normalize at read time so already stored Results work as well.
  if (machine.type !== "local-linux" && /^\/[a-z]:[\\/]/i.test(path)) path = path.slice(1);
  if (
    !/\.(png|jpe?g|webp|gif|avif|tiff?|heic|heif)$/i.test(path) ||
    !(machine.type === "local-linux" ? path.startsWith("/") : /^[a-z]:[\\/]/i.test(path))
  )
    throw new HubError(400, "INVALID_IMAGE_PATH", "Неподдерживаемый путь изображения");
  if (machine.type === "local-linux") {
    const file = await open(path, "r");
    try {
      const s = await file.stat();
      if (!s.isFile() || s.size > limit)
        throw new HubError(413, "IMAGE_TOO_LARGE", "Изображение больше 8 МБ");
      const bytes = Buffer.alloc(s.size + 1);
      const read = await file.read(bytes, 0, bytes.length, 0);
      if (read.bytesRead > s.size)
        throw new HubError(409, "IMAGE_CHANGED", "Файл изображения изменился");
      return bytes.subarray(0, read.bytesRead);
    } finally {
      await file.close();
    }
  }
  const script = [
    "$ErrorActionPreference='Stop'",
    "$f=[IO.File]::Open(" +
      quotePowerShell(path) +
      ",[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite)",
    "try {  $length=$f.Length; if($length -gt 8388608){throw 'IMAGE_TOO_LARGE'}; $b=New-Object byte[] ([int]$length); $n=0; while($n -lt $b.Length){$r=$f.Read($b,$n,$b.Length-$n); if($r -eq 0){throw 'IMAGE_TRUNCATED'}; $n+=$r}; [Console]::Out.Write([Convert]::ToBase64String($b)) } finally {$f.Dispose()}",
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
    const finish = (success: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stopProcess(child);
      if (success && /^[A-Za-z0-9+/]*={0,2}$/.test(out)) {
        resolve(Buffer.from(out, "base64"));
      } else
        reject(
          new HubError(
            503,
            "IMAGE_UNAVAILABLE",
            "Изображение пока недоступно. Проверь связь с компьютером и наличие файла (до 8 МБ).",
          ),
        );
    };
    const timer = setTimeout(() => finish(false), 15000);
    child.stdout.on("data", (b: Buffer) => {
      out += b.toString("ascii");
      if (out.length > Math.ceil(limit / 3) * 4) finish(false);
    });
    child.stderr.on("data", () => {});
    child.on("error", () => finish(false));
    child.on("close", (c) => finish(c === 0));
    child.stdin.end();
  });
}
