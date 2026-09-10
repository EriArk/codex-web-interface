import type { Store } from "./store.js";

export type Notice = {
  id: string;
  eventKey?: string;
  client: string;
  target: string;
  category: string;
  kind: string;
  createdAt: number;
};
type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as ObjectValue) : {};
}
function json(value: unknown): ObjectValue {
  try {
    return object(JSON.parse(String(value)));
  } catch {
    return {};
  }
}
function clip(value: string, limit: number) {
  const chars = Array.from(value);
  return chars.length > limit
    ? chars
        .slice(0, limit - 1)
        .join("")
        .trimEnd() + "…"
    : value;
}
/** Only public text enters this formatter. Omit code, URLs and local paths from previews. */
export function notificationText(value: unknown, limit = 180): string {
  if (typeof value !== "string") return "";
  return clip(
    value
      .slice(0, 8000)
      .replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, " ")
      .replace(/`+[^`\n]*`+/g, " ")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/\[[^\]]+\]:[^\n]*/g, " ")
      .replace(/(?:https?:\/\/|www\.|sandbox:|file:|data:)[^\s<>]+/gi, " ")
      .replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\s]+|(?:^|\s)\/[\w.~-][^\s]*/g, " ")
      .replace(/<[^>]*>/g, " ")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Remove control and direction-spoofing characters from lock-screen text.
      .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, " ")
      .replace(/[*#_~>|]/g, "")
      .replace(/\s+/g, " ")
      .trim(),
    limit,
  );
}
const details: Record<string, string> = {
  completed: "Ответ готов — открой чат, чтобы посмотреть результат.",
  question: "Ответь на вопрос, чтобы Codex продолжил работу.",
  approval: "Подтверди или отклони действие в чате.",
  failed: "Работа остановилась с ошибкой. Подробности — в чате.",
  unknown: "Связь прервалась или подтверждение не пришло. Проверь чат перед повторной отправкой.",
  test: "Здесь будут проект, чат и краткий итог. Нажатие откроет нужный диалог.",
};
const statuses: Record<string, string> = {
  completed: "Готово",
  question: "Нужен ответ",
  approval: "Нужно разрешение",
  failed: "Ошибка",
  unknown: "Нужна проверка",
  test: "Проверка уведомлений",
};
// Exact native-safe messages only. Raw error/command strings are never copied to push.
const gptErrors = new Map([
  [
    "Не удалось выбрать модель или режим в ChatGPT. Текст и файлы сохранены.",
    "Не удалось выбрать модель или режим. Текст и файлы сохранены.",
  ],
  [
    "Не удалось открыть чат в ChatGPT. Текст и файлы сохранены.",
    "Не удалось открыть чат. Текст и файлы сохранены.",
  ],
  [
    "Не удалось подготовить вложения в ChatGPT. Текст и файлы сохранены.",
    "Не удалось загрузить вложения. Текст и файлы сохранены.",
  ],
]);

export function noticeDisplay(
  store: Store,
  n: Notice,
  projectName?: (id: string) => string | undefined,
) {
  const db = store.db;
  const entry = (client: string, kind: string, id: unknown) =>
    json(
      db
        .prepare("SELECT value FROM library_entities WHERE client=? AND kind=? AND id=?")
        .get(client, kind, String(id ?? ""))?.value,
    );
  let project = "",
    chat = "",
    detail = details[n.kind] ?? "Открой чат, чтобы проверить состояние.";
  if (n.client === "gpt") {
    const job = db
      .prepare(
        "SELECT nativeId,substr(answer,1,8000) answer,assets<>'[]' hasAssets,error FROM gpt_jobs WHERE id=?",
      )
      .get(n.target);
    if (job) {
      const thread = entry("gpt", "thread", job.nativeId);
      chat = notificationText(thread.name, 72) || "Новый чат";
      const association = db
        .prepare("SELECT projectId FROM gpt_project_jobs WHERE jobId=? AND verified=1")
        .get(n.target);
      project = notificationText(
        entry("gpt", "project", thread.projectId || association?.projectId).name,
        48,
      );
      if (n.kind === "completed")
        detail =
          notificationText(job.answer) ||
          (job.hasAssets ? "Готовы изображения или файлы — открой результаты в чате." : detail);
      if (n.kind === "failed") detail = gptErrors.get(String(job.error)) ?? detail;
    }
  } else if (n.kind !== "test") {
    const thread = db
      .prepare("SELECT projectId,codexThreadId,title FROM threads WHERE id=?")
      .get(n.target);
    if (thread) {
      chat = notificationText(
        entry("codex", "thread", thread.codexThreadId).name || thread.title,
        72,
      );
      project = notificationText(
        entry("codex", "project", thread.projectId).name || projectName?.(String(thread.projectId)),
        48,
      );
    }
    const type = ["question", "approval"].includes(n.kind)
      ? "approval.requested"
      : "turn.completed";
    // Correlate the exact source event, never another turn's latest answer or question.
    const prefix = `codex:${n.target}:`;
    const sourceTurn = n.eventKey?.startsWith(prefix)
      ? n.eventKey.slice(prefix.length).split(`:${type}:`)[0]
      : "";
    const events = db
      .prepare(
        "SELECT seq,turnId,json_extract(payload,'$.id') id,json_extract(payload,'$.status') status FROM events WHERE threadId=? AND turnId=? AND type=? ORDER BY seq DESC LIMIT 64",
      )
      .all(n.target, sourceTurn || "", type);
    const event = events.find(
      (e) =>
        n.eventKey ===
        `codex:${n.target}:${e.turnId ?? e.seq}:${type}:${e.id ?? ""}:${e.status ?? ""}`,
    );
    if (event && n.kind === "completed" && event.turnId) {
      const answer = db
        .prepare(
          "SELECT substr(json_extract(payload,'$.text'),1,8000) text FROM events WHERE threadId=? AND turnId=? AND type='assistant.completed' AND seq<? AND COALESCE(json_extract(payload,'$.phase'),'') IN ('','final_answer') ORDER BY CASE WHEN json_extract(payload,'$.phase')='final_answer' THEN 0 ELSE 1 END,seq DESC LIMIT 1",
        )
        .get(n.target, String(event.turnId), Number(event.seq));
      detail = notificationText(answer?.text) || detail;
    } else if (event && ["question", "approval"].includes(n.kind)) {
      const request = json(
        db
          .prepare("SELECT substr(payload,1,32768) value FROM events WHERE seq=?")
          .get(Number(event.seq))?.value,
      );
      if (n.kind === "question" && Array.isArray(request.questions)) {
        const question = request.questions
          .map(object)
          .find((q) => q.isSecret === false && notificationText(q.question));
        detail = question ? notificationText(question.question) : detail;
      } else {
        detail =
          (
            {
              command: "Codex запрашивает запуск команды.",
              files: "Codex запрашивает изменение файлов.",
              permissions: "Codex запрашивает дополнительные права.",
            } as Record<string, string>
          )[String(request.kind)] ?? detail;
      }
    } else if (n.kind === "unknown" && n.eventKey?.startsWith("queue:")) {
      detail = "Сообщение в очереди не подтверждено. Проверь очередь перед повторной отправкой.";
    }
  }
  return {
    title: clip(
      `${n.client === "gpt" ? "GPT" : "Codex"}${project ? " · " + project : ""} · ${statuses[n.kind] ?? "Внимание"}`,
      100,
    ),
    body: clip([chat, detail].filter(Boolean).join("\n"), 280),
  };
}
