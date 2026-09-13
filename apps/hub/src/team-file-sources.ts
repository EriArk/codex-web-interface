import { lstatSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { HubError, type ProjectScope } from "@codex-web/shared";
import type { createApp } from "./app.js";
import { Artifacts } from "./artifacts.js";
import type { TeamAssets } from "./team-assets.js";

type Runtime = Awaited<ReturnType<typeof createApp>>;
const missing = () =>
  new HubError(404, "SOURCE_UNAVAILABLE", "Личный файл недоступен в выбранном проекте.");
export const fileSourceKey = (scope: ProjectScope, id: string) =>
  JSON.stringify({ client: scope.client, projectId: scope.projectId, id });

export function fileSources(runtime: Runtime, scope: ProjectScope, offset: number) {
  const db = runtime.sessions.store.db;
  const rows =
    scope.client === "codex"
      ? db
          .prepare(`SELECT a.id,COALESCE(f.name,'Снимок экрана') title FROM artifacts a
    JOIN threads t ON t.id=a.threadId LEFT JOIN artifact_files f ON f.id=a.id WHERE t.projectId=? ORDER BY a.createdAt DESC,a.id LIMIT 31 OFFSET ?`)
          .all(scope.projectId, offset)
      : db
          .prepare(`SELECT DISTINCT json_extract(a.value,'$.id') id,COALESCE(json_extract(a.value,'$.name'),'Файл GPT') title FROM gpt_jobs j,json_each(j.assets) a
      JOIN library_entities p ON p.client='gpt' AND p.kind='thread' AND p.id=j.nativeId WHERE json_extract(p.value,'$.projectId')=?
      AND COALESCE(json_extract(p.value,'$.deleted'),0)=0 ORDER BY j.createdAt DESC,id LIMIT 31 OFFSET ?`)
          .all(scope.projectId, offset);
  return {
    items: rows
      .slice(0, 30)
      .map((row) => ({ id: String(row.id), title: String(row.title), kind: "file" as const })),
    nextOffset: rows.length > 30 ? offset + 30 : null,
  };
}
/** Explicitly copies one selected saved artifact. It never opens or sends to a native chat. */
export async function stageFile(
  runtime: Runtime,
  assets: TeamAssets,
  actor: string,
  projectId: string,
  scope: ProjectScope,
  id: string,
) {
  const db = runtime.sessions.store.db;
  if (scope.client === "codex") {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw missing();
    const row = db
      .prepare(
        "SELECT a.id,f.name FROM artifacts a JOIN threads t ON t.id=a.threadId LEFT JOIN artifact_files f ON f.id=a.id WHERE a.id=? AND t.projectId=?",
      )
      .get(id, scope.projectId);
    if (!row) throw missing();
    const path = join(
      runtime.sessions.config.hub.resultsPath,
      id + (row.name === null ? ".png" : ".bin"),
    );
    const info = lstatSync(path);
    if (
      info.isSymbolicLink() ||
      !info.isFile() ||
      realpathSync(path) !== resolve(path) ||
      info.size > 32 * 1024 * 1024
    )
      throw missing();
    const file = new Artifacts(runtime.sessions.config.hub.resultsPath, runtime.sessions.store).get(
      id,
    );
    return assets.stage(
      actor,
      projectId,
      fileSourceKey(scope, id),
      file.name,
      file.mime,
      file.data,
    );
  }
  const row = db
    .prepare(`SELECT a.value FROM gpt_jobs j,json_each(j.assets) a JOIN library_entities p ON p.client='gpt' AND p.kind='thread' AND p.id=j.nativeId
    WHERE json_extract(a.value,'$.id')=? AND json_extract(p.value,'$.projectId')=? AND COALESCE(json_extract(p.value,'$.deleted'),0)=0 LIMIT 1`)
    .get(id, scope.projectId);
  if (!row) throw missing();
  const asset = JSON.parse(String(row.value));
  const response = /^file[-_]/.test(id)
    ? await runtime.gpt.asset(id)
    : await runtime.gpt.result(id);
  if (!response.ok || !response.body) throw missing();
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > 32 * 1024 * 1024)
      throw new HubError(413, "SHARED_FILE_TOO_LARGE", "Файл больше 32 МБ.");
    chunks.push(Buffer.from(chunk));
  }
  return assets.stage(
    actor,
    projectId,
    fileSourceKey(scope, id),
    String(asset.name || "Файл GPT"),
    response.headers.get("content-type")?.split(";")[0] ?? "application/octet-stream",
    Buffer.concat(chunks),
  );
}
