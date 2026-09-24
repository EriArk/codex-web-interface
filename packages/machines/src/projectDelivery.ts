import { spawn } from "node:child_process";
import {
  type DeliveryProbeRequest,
  type DeliveryProbeResult,
  type GitHubWorkProbeRequest,
  type GitHubWorkProbeResult,
  HubError,
  type MachineConfig,
} from "@codex-web/shared";
import { authorizeMachine } from "./authority.js";
import { deliveryProbe } from "./deliveryProbe.js";
import { githubWorkProbe } from "./githubWorkProbe.js";
import { quotePowerShell, stopProcess } from "./index.js";
import { verifyProjectRoot } from "./projectRoots.js";

const messages: Record<string, string> = {
  GITHUB_WORK_UNAVAILABLE: "GitHub пока недоступен. Проверь вход GitHub CLI на своём компьютере.",
  GITHUB_WORK_LOGIN: "Нужен вход GitHub CLI на своём компьютере.",
  GITHUB_WORK_ACCESS: "У выбранного GitHub-аккаунта нет доступа для этого действия.",
  GITHUB_WORK_CHANGED: "Issue или PR изменился. Проверь новую версию перед действием.",
  GITHUB_WORK_IDENTITY_CHANGED:
    "GitHub-аккаунт или репозиторий изменился. Подготовь действие заново.",
  GITHUB_WORK_REPOSITORY: "Рабочая папка больше не соответствует выбранному GitHub-репозиторию.",
  GITHUB_WORK_PATH: "Рабочая папка или служебное хранилище недоступны.",
  GITHUB_WORK_KEY: "Это подтверждение относится к другому GitHub-действию.",
  GITHUB_WORK_REQUEST: "Проверь параметры GitHub-действия.",
  GITHUB_WORK_UNKNOWN:
    "Исход GitHub-действия не подтверждён. Проверка состояния не отправляет его снова.",
  GITHUB_WORK_BUSY: "В этой рабочей папке уже выполняется GitHub-действие.",
  GITHUB_WORK_SELF: "Для этого действия выбери другого участника.",
  GITHUB_WORK_REJECTED: "GitHub отклонил действие. Проверь доступ и текущее состояние.",
  GITHUB_WORK_CAPACITY:
    "Хранилище подтверждений GitHub заполнено. Нужна проверка сохранённых операций.",
  GITHUB_WORK_DATA:
    "GitHub вернул неподдерживаемые данные. Сохранённое состояние остаётся доступным.",
  DELIVERY_UNAVAILABLE: "Компьютер пока не подтвердил операцию. Проверь её состояние.",
  DELIVERY_SYNC_BLOCKED:
    "Сначала сохрани локальные изменения и разреши конфликты. Рабочая копия не перезаписывалась.",
  DELIVERY_UNMERGED: "В рабочей копии есть незавершённое слияние. Разреши конфликты в проекте.",
  DELIVERY_CHANGED: "Файлы, ветка или индекс изменились. Подготовь операцию заново.",
  DELIVERY_REMOTE_CHANGED: "Удалённая ветка изменилась. Обнови состояние перед отправкой.",
  DELIVERY_PUSH_REJECTED: "Push отклонён. Обнови состояние веток; автоматического слияния не было.",
  DELIVERY_BUSY: "В этом проекте уже выполняется Git-операция.",
  DELIVERY_INDEX_BUSY: "Индекс Git занят другой операцией.",
  DELIVERY_INDEX_UNKNOWN: "Нужно проверить индекс Git. Коммит повторно не создаётся.",
  DELIVERY_UNKNOWN: "Исход пока не подтверждён. Проверка не повторяет операцию.",
  DELIVERY_SELECTION: "Выбери доступные изменённые файлы.",
  DELIVERY_EMPTY: "Выбранное содержимое уже сохранено в HEAD.",
  DELIVERY_REMOTE: "Для этой операции нужен доступный origin на GitHub.",
  DELIVERY_PR_BRANCH:
    "Сначала отправь рабочую ветку на GitHub. PR создаётся из неё в основную ветку.",
  DELIVERY_DETACHED: "Выбери рабочую ветку в Git перед коммитом.",
  DELIVERY_NO_REPO: "В папке проекта нет Git-репозитория.",
  DELIVERY_REPOSITORY_BOUNDARY: "Выбери проект с корнем этого Git-репозитория.",
  DELIVERY_KEY_REUSED: "Этот запрос относится к другой операции.",
  DELIVERY_GIT_FAILED: "Git не завершил операцию. Проверь его состояние и настройки на компьютере.",
  GIT_UNAVAILABLE: "На компьютере не найден Git.",
  GITHUB_UNAVAILABLE: "GitHub недоступен. Проверь вход GitHub CLI на компьютере.",
};
export const deliveryMessage = (code: string) => messages[code] ?? messages.DELIVERY_UNAVAILABLE!;
export async function runProjectDelivery(
  machine: MachineConfig,
  root: string,
  request: DeliveryProbeRequest,
): Promise<DeliveryProbeResult> {
  return runFixedProjectWorker(machine, root, request, () => deliveryProbe(root, request));
}
export async function runProjectGitHub(
  machine: MachineConfig,
  root: string | null,
  request: GitHubWorkProbeRequest,
): Promise<GitHubWorkProbeResult> {
  return runFixedProjectWorker(machine, root, { op: "github", request }, () =>
    githubWorkProbe(root, request),
  );
}
async function runFixedProjectWorker<T>(
  machine: MachineConfig,
  root: string | null,
  request: DeliveryProbeRequest | { op: "github"; request: GitHubWorkProbeRequest },
  local: () => Promise<T>,
): Promise<T> {
  authorizeMachine(machine);
  if (root !== null) await verifyProjectRoot(machine, root);
  else if (request.op !== "github")
    throw new HubError(400, "GITHUB_WORK_REQUEST", deliveryMessage("GITHUB_WORK_REQUEST"));
  if (machine.type === "local-linux") {
    try {
      return await local();
    } catch (e) {
      const code = e instanceof Error ? e.message : "DELIVERY_UNAVAILABLE";
      throw new HubError(
        409,
        messages[code] ? code : "DELIVERY_UNAVAILABLE",
        deliveryMessage(code),
      );
    }
  }
  if (!machine.codex.activityNode || !machine.ssh)
    throw new HubError(503, "DELIVERY_UNAVAILABLE", deliveryMessage("DELIVERY_UNAVAILABLE"));
  const script = `$ErrorActionPreference='Stop'; $worker=Join-Path $env:LOCALAPPDATA 'CodexWeb/delivery/DeliveryWorker.cjs'; if(-not (Test-Path -LiteralPath $worker)){exit 2}; & ${quotePowerShell(machine.codex.activityNode)} $worker request; exit $LASTEXITCODE`;
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
            messages[result.code] ? result.code : "DELIVERY_UNAVAILABLE",
            deliveryMessage(result.code),
          );
        resolve(result.value);
      } catch (e) {
        reject(
          e instanceof HubError
            ? e
            : new HubError(503, "DELIVERY_UNAVAILABLE", deliveryMessage("DELIVERY_UNAVAILABLE")),
        );
      }
    };
    const timer = setTimeout(
      () => finish(false),
      ["apply", "github"].includes(request.op) ? 250000 : 180000,
    );
    child.stdout.on("data", (b) => {
      output += b.toString("utf8");
      if (Buffer.byteLength(output) > (request.op === "github" ? 320 * 1024 * 1024 : 2097152))
        finish(false);
    });
    child.stderr.on("data", () => {});
    child.stdin.on("error", () => finish(false));
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0));
    child.stdin.end(JSON.stringify({ root, request }));
  });
}
