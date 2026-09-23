import { spawn } from "node:child_process";
import { type FileRequest, HubError, type MachineConfig } from "@codex-web/shared";
import { authorizeMachine } from "./authority.js";
import { fileToolsProbe } from "./fileToolsProbe.js";
import { quotePowerShell, stopProcess } from "./index.js";
import { verifyProjectRoot } from "./projectRoots.js";

export async function runFileTools(
  machine: MachineConfig,
  root: string,
  request: FileRequest,
  localReceiptRoot?: string,
): Promise<Awaited<ReturnType<typeof fileToolsProbe>>> {
  await verifyProjectRoot(machine, root);
  authorizeMachine(machine);
  const failure = () =>
    new HubError(
      503,
      "PROJECT_INSPECTION_FAILED",
      "Не удалось прочитать проект. Проверь путь, связь и доступность Git.",
    );
  if (machine.type === "local-linux") {
    try {
      return await fileToolsProbe(root, request, localReceiptRoot);
    } catch (error) {
      throw fileToolsError(
        (error as NodeJS.ErrnoException).code ?? (error instanceof Error ? error.message : ""),
      );
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
        const value = JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
        if (value.error) {
          reject(fileToolsError(value.error));
          return;
        }
        resolve(value);
      } catch (error) {
        reject(failure());
      }
    };
    const timer = setTimeout(() => finish(false), 90000);
    child.stdout.on("data", (b: Buffer) => {
      size += b.length;
      if (size > 16777216) finish(false);
      else chunks.push(b);
    });
    child.stderr.on("data", () => {});
    child.stdin.on("error", () => finish(false));
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0));
    child.stdin.end(
      `(${fileToolsProbe.toString()})(${JSON.stringify(root)},${JSON.stringify(request)}).then(value=>process.stdout.write(JSON.stringify(value))).catch(e=>process.stdout.write(JSON.stringify({error:e.code||e.message})));`,
    );
  });
}

export function fileToolsError(code: string) {
  const messages: Record<string, string> = {
    FILE_CHANGED:
      "Файл изменился после открытия. Черновик сохранён — открой текущую версию для сравнения.",
    FILE_EXISTS: "Файл или папка с таким именем уже существует.",
    FILE_PATH: "Этот путь недоступен для файловых операций.",
    FILE_ENCODING:
      "Редактор поддерживает текст UTF-8. Этот файл имеет другую кодировку или содержит двоичные данные.",
    FILE_TEXT_SIZE: "Этот файл слишком велик для редактора (до 2 МБ). Его можно скачать.",
    FILE_TREE_LARGE: "Слишком много файлов для одной операции. Выбери отдельную вложенную папку.",
    FILE_UNKNOWN:
      "Операция ещё не подтверждена. Обнови содержимое папки перед следующим действием.",
    FILE_BUSY: "В этой папке уже выполняется файловая операция.",
    ENOENT: "Файл или папка больше не существует.",
    EACCES: "На компьютере нет прав для изменения этого файла.",
    EPERM: "Файл занят или защищён от изменения.",
    FILE_REQUEST: "Проверь параметры файловой операции.",
  };
  return new HubError(
    code === "FILE_CHANGED" || code === "FILE_EXISTS" ? 409 : 400,
    messages[code] ? code : "FILE_OPERATION_FAILED",
    messages[code] ?? "Не удалось завершить файловую операцию.",
  );
}
