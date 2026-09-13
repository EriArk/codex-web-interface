import { spawn } from "node:child_process";
import { statfs } from "node:fs/promises";
import { freemem, totalmem, uptime } from "node:os";
import type { MachineConfig, MachineProbe } from "@codex-web/shared";
import { quotePowerShell, stopProcess } from "./index.js";
import { verifyProjectRoot } from "./projectRoots.js";

type Metrics = NonNullable<MachineProbe["metrics"]>;
export async function readMachineResources(machine: MachineConfig, root: string): Promise<Metrics> {
  await verifyProjectRoot(machine, root);
  if (machine.type === "local-linux") {
    const disk = await statfs(root).catch(() => undefined);
    const limit = process.constrainedMemory();
    const memoryTotal = limit ? Math.min(totalmem(), limit) : totalmem();
    return {
      memoryTotal,
      memoryAvailable: Math.min(memoryTotal, freemem(), process.availableMemory()),
      bootedAt: Date.now() - uptime() * 1000,
      ...(disk
        ? { diskAvailable: disk.bavail * disk.bsize, diskTotal: disk.blocks * disk.bsize }
        : {}),
    };
  }
  const script = [
    "$ErrorActionPreference='Stop'",
    "$out=@{}",
    "try{$os=Get-CimInstance Win32_OperatingSystem;$out.memoryTotal=[double]$os.TotalVisibleMemorySize*1024;$out.memoryAvailable=[double]$os.FreePhysicalMemory*1024;$out.bootedAt=([DateTimeOffset]$os.LastBootUpTime).ToUnixTimeMilliseconds()}catch{}",
    "try{$v=(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average;if($null -ne $v){$out.cpuPercent=[double]$v}}catch{}",
    `$drive=[IO.Path]::GetPathRoot(${quotePowerShell(root)}).TrimEnd([char]92)`,
    `if($drive -match '^[A-Za-z]:$'){try{$disk=Get-CimInstance Win32_LogicalDisk -Filter ("DeviceID='"+$drive+"'");if($disk){$out.diskAvailable=[double]$disk.FreeSpace;$out.diskTotal=[double]$disk.Size}}catch{}}`,
    "[Console]::Out.Write(($out | ConvertTo-Json -Compress))",
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
      "ConnectTimeout=6",
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
  return new Promise((resolve) => {
    let output = "",
      done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stopProcess(child);
      let metrics: Metrics = {};
      try {
        const raw = ok ? JSON.parse(output) : {};
        for (const key of [
          "memoryTotal",
          "memoryAvailable",
          "diskTotal",
          "diskAvailable",
          "cpuPercent",
          "bootedAt",
        ] as const) {
          if (
            typeof raw[key] === "number" &&
            Number.isFinite(raw[key]) &&
            raw[key] >= 0 &&
            (key !== "cpuPercent" || raw[key] <= 100)
          )
            metrics[key] = raw[key];
        }
      } catch {
        metrics = {};
      }
      resolve(metrics);
    };
    const timer = setTimeout(() => finish(false), 8000);
    child.stdout.on("data", (b: Buffer) => {
      output += b.toString("utf8");
      if (output.length > 8192) finish(false);
    });
    child.stderr.on("data", () => {});
    child.stdin.on("error", () => finish(false));
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0));
    child.stdin.end();
  });
}
