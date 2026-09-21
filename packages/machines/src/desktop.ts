import { spawn } from "node:child_process";
import { HubError, type MachineConfig } from "@codex-web/shared";
import { authorizeMachine } from "./authority.js";
import { quotePowerShell, stopProcess } from "./index.js";

export interface DesktopState {
  available: boolean;
  running: boolean;
  activityKnown: boolean;
  activeTasks: number;
  operation: null | {
    id: string;
    kind: "open" | "restart" | "forcerestart" | "forcerelease" | "probe";
    state: "queued" | "restarting" | "completed" | "failed" | "unknown";
    code: string;
    requestedAt: number;
  };
}
const messages: Record<string, string> = {
  DESKTOP_WINDOW_UNAVAILABLE: "Не удалось развернуть окно Codex. Проверь компьютер через Remote.",
  DESKTOP_BUSY: "Codex ещё работает. Дождись завершения задач перед перезапуском.",
  DESKTOP_ACTIVITY_UNAVAILABLE: "Не удалось проверить активные задачи. Перезапуск пока недоступен.",
  DESKTOP_PACKAGE_UNAVAILABLE: "Приложение Codex не найдено на компьютере.",
  DESKTOP_RESTART_PENDING: "Действие с Codex уже выполняется.",
  DESKTOP_RESTART_COOLDOWN: "Подожди минуту перед следующим действием с Codex.",
  DESKTOP_INTERACTIVE_SESSION_REQUIRED: "Войди в Windows на компьютере, чтобы открыть Codex.",
};
export function desktopError(code: string): HubError {
  return new HubError(
    ["DESKTOP_BUSY", "DESKTOP_RESTART_PENDING", "DESKTOP_RESTART_COOLDOWN"].includes(code)
      ? 409
      : 503,
    code,
    messages[code] ?? "Не удалось выполнить действие. Проверь Codex в Remote.",
  );
}
export function parseDesktopReply(output: string): DesktopState {
  let value: DesktopState & { error?: string };
  try {
    value = JSON.parse(output);
  } catch {
    throw desktopError("DESKTOP_CONTROL_UNAVAILABLE");
  }
  if (value?.error)
    throw desktopError(
      /^DESKTOP_[A-Z_]{1,70}$/.test(value.error) ? value.error : "DESKTOP_CONTROL_UNAVAILABLE",
    );
  const operation = value?.operation;
  if (
    value?.available !== true ||
    typeof value.running !== "boolean" ||
    typeof value.activityKnown !== "boolean" ||
    !Number.isInteger(value.activeTasks) ||
    value.activeTasks < 0 ||
    value.activeTasks > 10000 ||
    (operation !== null &&
      (!operation ||
        !/^[a-f0-9-]{36}$/i.test(operation.id) ||
        !["open", "restart", "forcerestart", "forcerelease", "probe"].includes(operation.kind) ||
        !["queued", "restarting", "completed", "failed", "unknown"].includes(operation.state) ||
        !/^(?:DESKTOP_[A-Z_]{1,70})?$/.test(operation.code) ||
        !Number.isFinite(operation.requestedAt)))
  ) {
    throw desktopError("DESKTOP_CONTROL_UNAVAILABLE");
  }
  return {
    available: true,
    running: value.running,
    activityKnown: value.activityKnown,
    activeTasks: value.activeTasks,
    operation: operation
      ? {
          id: operation.id,
          kind: operation.kind,
          state: operation.state,
          code: operation.code,
          requestedAt: operation.requestedAt,
        }
      : null,
  };
}
export async function controlDesktop(
  machine: MachineConfig,
  action: "Status" | "Open" | "Restart" | "ForceRestart" | "ForceRelease",
  id?: string,
  threadId?: string,
): Promise<DesktopState> {
  authorizeMachine(machine);
  if (machine.type !== "ssh-windows" || !machine.codex.desktopControl || !machine.ssh)
    throw desktopError("DESKTOP_CONTROL_UNAVAILABLE");
  if (action !== "Status" && !/^[a-f0-9-]{36}$/i.test(id ?? ""))
    throw desktopError("DESKTOP_INVALID_REQUEST");
  if (
    threadId !== undefined &&
    (action !== "Open" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(threadId))
  )
    throw desktopError("DESKTOP_INVALID_REQUEST");
  const script =
    "& " +
    quotePowerShell(machine.codex.desktopControl) +
    " -Action " +
    action +
    (id ? " -RequestId " + quotePowerShell(id) : "") +
    (threadId ? " -ThreadId " + quotePowerShell(threadId) : "") +
    "; exit $LASTEXITCODE";
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
      // Apply only to this fixed, installed control script; preserve the machine policy.
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    { stdio: "pipe", detached: process.platform !== "win32", windowsHide: true },
  );
  return new Promise((resolve, reject) => {
    let output = "",
      done = false;
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stopProcess(child);
      if (error) {
        reject(error);
        return;
      }
      try {
        resolve(parseDesktopReply(output));
      } catch (e) {
        reject(e);
      }
    };
    const timer = setTimeout(() => finish(desktopError("DESKTOP_OUTCOME_UNKNOWN")), 20000);
    child.stdout.on("data", (data: Buffer) => {
      output += data.toString("utf8");
      if (output.length > 16384) finish(desktopError("DESKTOP_CONTROL_UNAVAILABLE"));
    });
    child.stderr.on("data", () => {});
    child.on("error", () => finish(desktopError("DESKTOP_CONTROL_UNAVAILABLE")));
    child.on("close", () => finish());
    child.stdin.end();
  });
}
