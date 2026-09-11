import { spawn } from "node:child_process";
import {
  HubError,
  type MachineConfig,
  type StagingRequest,
  type StagingResponse,
} from "@codex-web/shared";
import { quotePowerShell, stopProcess } from "./index.js";
import { stagingProbe } from "./stagingProbe.js";
export async function inspectMachineStaging(
  machine: MachineConfig,
  request: StagingRequest = { op: "inspect" },
): Promise<StagingResponse> {
  if (machine.type !== "ssh-windows" || !machine.ssh || !machine.codex.activityNode)
    throw new HubError(409, "STAGING_UNAVAILABLE", "Не удалось проверить копии на компьютере.");
  const program = `(${stagingProbe.toString()})(require('node:path').join(process.env.LOCALAPPDATA,'CodexWeb'),${JSON.stringify(request)}).then(value=>process.stdout.write(JSON.stringify(value))).catch(()=>process.exitCode=1)`;
  // Send the fixed probe through stdin: Windows OpenSSH's shell can impose an
  // 8 KiB command-line limit even when CreateProcess permits more.
  const expression = "eval(require('node:fs').readFileSync(0,'utf8'))";
  const script = `$ErrorActionPreference='Stop'; & ${quotePowerShell(machine.codex.activityNode)} -e ${quotePowerShell(expression)}; exit $LASTEXITCODE`;
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
  return new Promise((resolve, reject) => {
    let output = "",
      done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stopProcess(child);
      try {
        if (!ok) throw Error();
        const value = JSON.parse(output);
        if (!value || !Number.isFinite(value.checkedAt)) throw Error();
        resolve(value);
      } catch {
        reject(
          new HubError(
            503,
            "STAGING_UNAVAILABLE",
            "Не удалось проверить копии на компьютере. Исходные файлы сохранены.",
          ),
        );
      }
    };
    const timer = setTimeout(() => finish(false), request.op === "inspect" ? 15000 : 60000);
    child.stdout.on("data", (b) => {
      output += b.toString("utf8");
      if (output.length > 36 * 1024 * 1024) finish(false);
    });
    child.stderr.on("data", () => {});
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0));
    child.stdin.on("error", () => finish(false));
    child.stdin.end(program);
  });
}
