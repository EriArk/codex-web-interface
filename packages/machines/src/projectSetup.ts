import { spawn } from "node:child_process";
import {
  HubError,
  type MachineConfig,
  type SetupProbeRequest,
  type SetupProbeResult,
} from "@codex-web/shared";
import { authorizeMachine } from "./authority.js";
import { quotePowerShell, stopProcess } from "./index.js";
import { verifyProjectRoot } from "./projectRoots.js";
import { setupProbe } from "./setupProbe.js";

const messages: Record<string, string> = {
  GITHUB_UNAVAILABLE: "GitHub недоступен. Проверь вход GitHub CLI на выбранном компьютере.",
  GIT_UNAVAILABLE: "На выбранном компьютере недоступен Git.",
  DIRECTORY_MISSING: "Папка не найдена. Выбери существующую или создание новой.",
  DIRECTORY_NOT_EMPTY: "В папке уже есть файлы. Для клонирования выбери пустую или новую папку.",
  DIRECTORY_REQUIRED: "Выбранный путь не является папкой.",
  REMOTE_CONFLICT: "Папка связана с другим репозиторием. Существующий origin сохранён.",
  UNRELATED_REPOSITORY:
    "У этой папки своя Git-история без подходящего origin. Подключи репозиторий вручную или выбери новую папку для клонирования.",
  PARENT_REPOSITORY:
    "Папка находится внутри другого Git-проекта. Выбери корень репозитория или отдельную папку.",
  REPOSITORY_EXISTS: "Такой репозиторий уже существует. Выбери подключение существующего.",
  REPOSITORY_MISSING: "Репозиторий не найден или недоступен этому GitHub-аккаунту.",
  OWNER_REQUIRED: "Новый репозиторий создаётся в текущем GitHub-аккаунте.",
  SETUP_CHANGED: "Содержимое папки или состояние Git изменилось. Проверь план ещё раз.",
  SETUP_BUSY: "На этой папке уже выполняется настройка. Дождись её завершения.",
  CREATE_OUTCOME_UNKNOWN:
    "GitHub пока не подтвердил создание. Проверка не создаст второй репозиторий.",
  CLONE_OUTCOME_UNKNOWN:
    "Клонирование не подтверждено. Подготовленные файлы сохранены; проверь состояние операции.",
  INVALID_PATH: "Не удалось использовать этот путь проекта.",
  OPERATION_CONFLICT: "Эта операция уже сохранена с другими параметрами.",
  SETUP_UNAVAILABLE: "Настройка проекта не ответила. Состояние операции сохранено.",
};
export const setupMessage = (code: string, op: SetupProbeRequest["op"] = "apply") => {
  if (
    (!messages[code] || code === "SETUP_UNAVAILABLE") &&
    (op === "repositories" || op === "inspect")
  )
    return "Не удалось связаться с помощником настройки на выбранном компьютере. Проверь, что компьютер включён и подключён. Создание ещё не запускалось.";
  return messages[code] ?? messages.SETUP_UNAVAILABLE!;
};
export async function runProjectSetup(
  machine: MachineConfig,
  request: SetupProbeRequest,
): Promise<SetupProbeResult> {
  authorizeMachine(machine);
  if (request.op === "inspect" || request.op === "apply")
    await verifyProjectRoot(machine, request.input.workingDirectory, request.input.createDirectory);
  if (machine.type === "local-linux") {
    try {
      return await setupProbe(request);
    } catch (e) {
      const code = e instanceof Error ? e.message : "SETUP_UNAVAILABLE";
      throw new HubError(
        409,
        messages[code] ? code : "SETUP_UNAVAILABLE",
        setupMessage(code, request.op),
      );
    }
  }
  if (!machine.codex.activityNode || !machine.ssh)
    throw new HubError(503, "SETUP_UNAVAILABLE", setupMessage("SETUP_UNAVAILABLE", request.op));
  const script = `$ErrorActionPreference='Stop'; $worker=Join-Path $env:LOCALAPPDATA 'CodexWeb/project-setup/ProjectSetupWorker.cjs'; if(-not (Test-Path -LiteralPath $worker)){exit 2}; & ${quotePowerShell(machine.codex.activityNode)} $worker request; exit $LASTEXITCODE`;
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
            messages[result.code] ? result.code : "SETUP_UNAVAILABLE",
            setupMessage(result.code, request.op),
          );
        resolve(result.value);
      } catch (e) {
        reject(
          e instanceof HubError
            ? e
            : new HubError(503, "SETUP_UNAVAILABLE", setupMessage("SETUP_UNAVAILABLE", request.op)),
        );
      }
    };
    const timer = setTimeout(() => finish(false), request.op === "apply" ? 250000 : 45000);
    child.stdout.on("data", (b) => {
      output += b.toString("utf8");
      if (output.length > 2097152) finish(false);
    });
    child.stderr.on("data", () => {});
    child.stdin.on("error", () => finish(false));
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0));
    child.stdin.end(JSON.stringify(request));
  });
}
