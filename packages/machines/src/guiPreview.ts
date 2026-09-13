import { spawn } from "node:child_process";
import {
  type GuiPreviewRequest,
  type GuiPreviewResponse,
  HubError,
  type MachineConfig,
} from "@codex-web/shared";
import { quotePowerShell, stopProcess } from "./index.js";
import { verifyProjectRoot } from "./projectRoots.js";

const messages: Record<string, string> = {
  PREVIEW_UNAVAILABLE: "Предпросмотр пока недоступен. Проверь подключение компьютера.",
  PREVIEW_ACTION: "Это действие больше не настроено на компьютере.",
  PREVIEW_CONFIG: "Проверь настройку предпросмотра на компьютере.",
  PREVIEW_BUSY: "Предыдущий предпросмотр ещё открыт. Сначала закрой его.",
  PREVIEW_EARLY_EXIT: "Приложение завершилось до появления своего окна.",
  PREVIEW_WINDOW_TIMEOUT: "Окно приложения не появилось вовремя.",
  PREVIEW_BLANK: "Приложение вернуло пустой снимок окна.",
  PREVIEW_CAPTURE_TIMEOUT: "Приложение не ответило на запрос снимка.",
  PREVIEW_STOPPED: "Предпросмотр остановлен.",
  PREVIEW_EXPIRED: "Время предпросмотра истекло. Повторного запуска не было.",
  PREVIEW_KEY_REUSED: "Этот запрос уже относится к другому предпросмотру.",
  PREVIEW_MISSING: "Компьютер не нашёл этот предпросмотр. Повторного запуска не было.",
  PREVIEW_CAPTURE: "Не удалось получить снимок окна. Можно открыть Remote.",
  PREVIEW_LAUNCH: "Не удалось запустить настроенное приложение.",
  PREVIEW_CAPACITY: "Хранилище предпросмотров заполнено. Нужна проверка на компьютере.",
};
export const guiPreviewMessage = (code: string) => messages[code] ?? messages.PREVIEW_CAPTURE!;
export async function runGuiPreview(
  machine: MachineConfig,
  root: string,
  request: GuiPreviewRequest,
): Promise<GuiPreviewResponse> {
  await verifyProjectRoot(machine, root);
  if (machine.type !== "ssh-windows" || !machine.ssh || !machine.codex.activityNode) {
    if (request.op === "catalog") return { installed: false, actions: [] };
    throw new HubError(409, "PREVIEW_UNAVAILABLE", guiPreviewMessage("PREVIEW_UNAVAILABLE"));
  }
  const script = `$ErrorActionPreference='Stop'; $worker=Join-Path $env:LOCALAPPDATA 'CodexWeb/gui-preview/GuiPreviewWorker.cjs'; if(-not(Test-Path -LiteralPath $worker)){Write-Output '{"ok":true,"value":{"installed":false,"actions":[]}}'; exit 0}; & ${quotePowerShell(machine.codex.activityNode)} $worker request; exit $LASTEXITCODE`;
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
        const result = JSON.parse(output);
        if (!result.ok)
          throw new HubError(
            409,
            messages[result.code] ? result.code : "PREVIEW_UNAVAILABLE",
            guiPreviewMessage(result.code),
          );
        resolve(result.value);
      } catch (e) {
        reject(
          e instanceof HubError
            ? e
            : new HubError(503, "PREVIEW_UNAVAILABLE", guiPreviewMessage("PREVIEW_UNAVAILABLE")),
        );
      }
    };
    const timer = setTimeout(() => finish(false), 30000);
    child.stdout.on("data", (b) => {
      output += b.toString("utf8");
      if (output.length > 12 * 1024 * 1024) finish(false);
    });
    child.stderr.on("data", () => {});
    child.stdin.on("error", () => finish(false));
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0));
    child.stdin.end(JSON.stringify({ root, request }));
  });
}
