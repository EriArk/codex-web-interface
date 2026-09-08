import { spawn } from "node:child_process";
import { HubError, type InspectRequest, type MachineConfig } from "@codex-web/shared";
import { quotePowerShell, stopProcess } from "./index.js";
import { inspectorProbe } from "./inspectorProbe.js";

export async function inspectProject(
  machine: MachineConfig,
  root: string,
  request: InspectRequest,
): Promise<Awaited<ReturnType<typeof inspectorProbe>>> {
  const failure = () =>
    new HubError(
      503,
      "PROJECT_INSPECTION_FAILED",
      "Не удалось прочитать проект. Проверь путь, связь и доступность Git.",
    );
  if (machine.type === "local-linux") {
    try {
      return await inspectorProbe(root, request);
    } catch {
      throw failure();
    }
  }
  if (!machine.codex.activityNode)
    throw new HubError(
      503,
      "PROJECT_INSPECTOR_UNAVAILABLE",
      "На компьютере не настроен просмотр файлов.",
    );
  const script = `$ErrorActionPreference='Stop'; & ${quotePowerShell(machine.codex.activityNode)} --no-warnings -; exit $LASTEXITCODE`;
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
      try {
        if (!ok) throw failure();
        resolve(JSON.parse(Buffer.concat(chunks, size).toString("utf8")));
      } catch {
        reject(failure());
      }
    };
    const timer = setTimeout(() => finish(false), 25000);
    child.stdout.on("data", (b: Buffer) => {
      size += b.length;
      if (size > 1572864) finish(false);
      else chunks.push(b);
    });
    child.stderr.on("data", () => {});
    child.stdin.on("error", () => finish(false));
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0));
    child.stdin.end(
      `(${inspectorProbe.toString()})(${JSON.stringify(root)},${JSON.stringify(request)}).then(value=>process.stdout.write(JSON.stringify(value))).catch(()=>process.exitCode=1);`,
    );
  });
}
