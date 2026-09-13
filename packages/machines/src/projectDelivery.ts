import { spawn } from "node:child_process";
import {
  type DeliveryProbeRequest,
  type DeliveryProbeResult,
  HubError,
  type MachineConfig,
} from "@codex-web/shared";
import { deliveryProbe } from "./deliveryProbe.js";
import { quotePowerShell, stopProcess } from "./index.js";
import { verifyProjectRoot } from "./projectRoots.js";

const messages: Record<string, string> = {
  DELIVERY_UNAVAILABLE: "Компьютер пока не подтвердил операцию. Проверь её состояние.",
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
  await verifyProjectRoot(machine, root);
  if (machine.type === "local-linux") {
    try {
      return await deliveryProbe(root, request);
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
    const timer = setTimeout(() => finish(false), request.op === "apply" ? 250000 : 180000);
    child.stdout.on("data", (b) => {
      output += b.toString("utf8");
      if (output.length > 2097152) finish(false);
    });
    child.stderr.on("data", () => {});
    child.stdin.on("error", () => finish(false));
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0));
    child.stdin.end(JSON.stringify({ root, request }));
  });
}
