import type { NotebookLink } from "@codex-web/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { GptService } from "./gpt.js";
import type { Sessions } from "./sessions.js";

const normalized = (text: string) => text.normalize("NFKC").toLocaleLowerCase("ru");
export function searchSnippet(text: string, query: string) {
  const at = normalized(text).indexOf(normalized(query));
  if (at < 0) return null;
  const start = Math.max(0, at - 70);
  return (
    (start ? "…" : "") + text.slice(start, start + 320) + (text.length > start + 320 ? "…" : "")
  );
}
export function registerContentSearch(app: FastifyInstance, sessions: Sessions, gpt: GptService) {
  app.get("/api/workspace/search", async (req) => {
    const q = z
      .object({
        q: z.string().trim().min(2).max(120),
        client: z.enum(["codex", "gpt"]).default("codex"),
        threadId: z
          .string()
          .regex(/^[a-zA-Z0-9_-]{1,100}$/)
          .optional(),
        offset: z.coerce.number().int().min(0).max(1000000).default(0),
      })
      .parse(req.query);
    const items: { target: NotebookLink; snippet: string }[] = [];
    if (q.threadId && q.client === "gpt") {
      gpt.library.assertExists("thread", q.threadId);
      const messages = await gpt.historyCache.messages(q.threadId),
        batch = messages
          .slice()
          .reverse()
          .slice(q.offset, q.offset + 500);
      for (const message of batch) {
        const snippet = searchSnippet(message.text, q.q);
        if (snippet !== null)
          items.push({
            target: {
              client: "gpt",
              kind: "thread",
              id: q.threadId,
              threadId: q.threadId,
              messageId: message.id,
              title: message.role === "user" ? "Ваше сообщение" : "Ответ GPT",
              availability: "unknown",
            },
            snippet,
          });
      }
      return {
        items,
        nextOffset: q.offset + batch.length < messages.length ? q.offset + batch.length : null,
        coverage: "Текущая ветка выбранного чата ChatGPT",
        scanned: batch.length,
      };
    }
    const db = sessions.store.db;
    // Each explicit page scans a bounded number of existing public records. No native writer,
    // filesystem traversal, background chat crawling or hidden tool/reasoning payloads.
    const sql = q.threadId
      ? `SELECT m.id,'thread' kind,'codex' client,t.projectId,t.title,m.text body,m.threadId,m.id messageId FROM messages m JOIN threads t ON t.id=m.threadId WHERE m.threadId=? AND m.role IN ('user','assistant') AND m.phase NOT IN ('analysis','reasoning') ORDER BY m.firstSeq DESC LIMIT 501 OFFSET ?`
      : `SELECT * FROM (
    SELECT id,'note' kind,COALESCE(json_extract(scope,'$.client'),'codex') client,json_extract(scope,'$.projectId') projectId,title,body,NULL threadId,NULL messageId,updatedAt stamp FROM workspace_notes
    UNION ALL SELECT id,'task',COALESCE(json_extract(scope,'$.client'),'codex'),json_extract(scope,'$.projectId'),title,body,NULL,NULL,updatedAt FROM workspace_tasks
    UNION ALL SELECT id,'plan',json_extract(scope,'$.client'),json_extract(scope,'$.projectId'),json_extract(value,'$.title'),search,NULL,NULL,updatedAt FROM project_plans
    UNION ALL SELECT id,'report',json_extract(scope,'$.client'),json_extract(scope,'$.projectId'),title,body,NULL,NULL,createdAt FROM project_reports
    UNION ALL SELECT m.id,'thread','codex',t.projectId,t.title,m.text,m.threadId,m.id,CAST(unixepoch(m.createdAt)*1000 AS INTEGER) FROM messages m JOIN threads t ON t.id=m.threadId WHERE m.role IN ('user','assistant') AND m.phase NOT IN ('analysis','reasoning')
   ) ORDER BY stamp DESC,kind,id LIMIT 501 OFFSET ?`;
    const rows = db
      .prepare(sql)
      .all(...(q.threadId ? [q.threadId, q.offset] : [q.offset])) as Record<string, any>[];
    for (const row of rows.slice(0, 500)) {
      const snippet = searchSnippet(String(row.title ?? "") + "\n" + String(row.body ?? ""), q.q);
      if (snippet === null) continue;
      items.push({
        target: {
          client: row.client,
          kind: row.kind,
          id: row.threadId ?? row.id,
          title: row.title ?? "Без названия",
          ...(row.projectId ? { projectId: row.projectId } : {}),
          ...(row.threadId ? { threadId: row.threadId, messageId: row.messageId } : {}),
          availability: "unknown",
        },
        snippet,
      });
    }
    return {
      items,
      nextOffset: rows.length > 500 ? q.offset + 500 : null,
      scanned: Math.min(rows.length, 500),
      coverage: q.threadId
        ? "Сохранённые на сервере сообщения Codex"
        : "Заметки, задачи, планы, отчёты и сохранённые сообщения Codex. История GPT ищется в выбранном чате.",
    };
  });
}
