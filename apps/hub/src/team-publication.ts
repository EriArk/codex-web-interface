import { createHash } from "node:crypto";
import {
  HubError,
  type ProjectScope,
  type SharedAsset,
  type SharedItemKind,
  type SharedMaterial,
  sharedMaterialSchema,
} from "@codex-web/shared";
import type { createApp } from "./app.js";
import { Notebook } from "./notebook.js";
import { ProjectCores } from "./project-core.js";
import { WorkspaceTasks } from "./tasks.js";
import type { TeamAssets } from "./team-assets.js";
import { fileSourceKey, fileSources } from "./team-file-sources.js";

type Runtime = Awaited<ReturnType<typeof createApp>>;
export type PublicationKind = "core" | "note" | "task" | "plan" | "report" | "review" | "file";
export function publicationSources(
  runtime: Runtime,
  scope: ProjectScope,
  kind: PublicationKind,
  offset: number,
) {
  const key = scope.client + ":" + scope.projectId,
    work = runtime.projectWork;
  if (kind === "file") return fileSources(runtime, scope, offset);
  if (kind === "core") {
    const core = new ProjectCores(runtime.sessions).get(scope);
    return {
      items: core.revision
        ? [{ id: scope.projectId, title: "Основа проекта", kind, revision: core.revision }]
        : [],
      nextOffset: null,
    };
  }
  const page =
    kind === "note"
      ? new Notebook(runtime.sessions).list(key, "", offset)
      : kind === "task"
        ? new WorkspaceTasks(runtime.sessions).list(
            key,
            "all",
            "",
            offset,
            new Date().toISOString().slice(0, 10),
          )
        : kind === "plan"
          ? work.plans.list(key, "", offset)
          : kind === "review"
            ? work.reviews.list(key, offset)
            : work.context.reports(key, offset);
  return {
    items: page.items.map((item) => ({
      id: item.id,
      title: item.title,
      kind,
      ...("revision" in item ? { revision: item.revision } : {}),
    })),
    nextOffset: page.nextOffset,
  };
}
/** Only the publisher's saved visible material; source links and private native payloads are omitted. */
export function publicationPreview(
  runtime: Runtime,
  actor: string,
  scope: ProjectScope,
  selected: { id: string; kind: PublicationKind }[],
  attachments?: {
    assets: TeamAssets;
    projectId: string;
    files: { sourceId: string; assetId: string }[];
  },
) {
  if (new Set(selected.map((item) => item.kind + ":" + item.id)).size !== selected.length)
    throw new HubError(400, "PUBLICATION_DUPLICATE", "Материал выбран дважды.");
  const items = selected.map((item) => {
    let sourceScope: ProjectScope | null,
      content: SharedMaterial,
      revision: number,
      files: SharedAsset[] | undefined;
    if (item.kind === "core") {
      if (item.id !== scope.projectId)
        throw new HubError(404, "SOURCE_UNAVAILABLE", "Личный материал недоступен.");
      const value = new ProjectCores(runtime.sessions).get(scope);
      if (!value.revision)
        throw new HubError(404, "SOURCE_UNAVAILABLE", "Основа проекта ещё не сохранена.");
      sourceScope = value.scope;
      revision = value.revision;
      content = { kind: "core", title: "Основа проекта", value: value.value };
    } else if (item.kind === "note") {
      const value = new Notebook(runtime.sessions).get(item.id);
      sourceScope = value.scope;
      revision = value.revision;
      content = { kind: "note", title: value.title, body: value.body };
    } else if (item.kind === "task") {
      const value = new WorkspaceTasks(runtime.sessions).get(item.id);
      sourceScope = value.scope;
      revision = value.revision;
      content = {
        kind: "task",
        title: value.title,
        body: value.body,
        status: value.status,
        priority: value.priority,
        dueAt: value.dueAt,
      };
    } else if (item.kind === "plan") {
      const value = runtime.projectWork.plans.get(item.id);
      sourceScope = value.scope;
      revision = value.revision;
      content = {
        kind: "plan",
        title: value.title,
        description: value.description,
        sections: value.sections,
        status: value.status,
      };
    } else if (item.kind === "file") {
      const selected = attachments?.files.find((f) => f.sourceId === item.id);
      if (!selected || !attachments)
        throw new HubError(409, "FILE_PREVIEW_REQUIRED", "Сначала просмотри выбранные файлы.");
      const file = attachments.assets.selected(
        actor,
        attachments.projectId,
        selected.assetId,
        fileSourceKey(scope, item.id),
      );
      files = [file];
      sourceScope = scope;
      revision = 1;
      content = {
        kind: "result",
        title: file.name.slice(0, 120),
        body: `Файл: ${file.name}\nРазмер: ${file.bytes} байт.`,
        outcome: "info",
      };
    } else if (item.kind === "review") {
      const value = runtime.projectWork.reviews.get(item.id);
      sourceScope = value.scope;
      revision = value.revision;
      content = {
        kind: "review",
        title: value.title.slice(0, 120),
        body: value.answer,
        feedback: value.note,
        outcome:
          value.state === "accepted" || value.state === "needs_fixes" ? value.state : "pending",
      };
    } else {
      const value = runtime.projectWork.context.report(item.id);
      sourceScope = value.scope;
      revision = value.createdAt;
      content = {
        kind: "report",
        title: value.title,
        body: value.body,
        periodFrom: value.periodFrom,
        periodTo: value.periodTo,
      };
    }
    if (sourceScope?.client !== scope.client || sourceScope.projectId !== scope.projectId)
      throw new HubError(
        404,
        "SOURCE_UNAVAILABLE",
        "Личный материал недоступен в выбранном проекте.",
      );
    return {
      content: sharedMaterialSchema.parse(content),
      ...(files ? { files } : {}),
      source: {
        ownerId: actor,
        client: scope.client,
        kind: (item.kind === "file" ? "result" : item.kind) as SharedItemKind,
        id: item.id,
        projectId: scope.projectId,
      },
      revision,
    };
  });
  const encoded = JSON.stringify(items);
  if (encoded.length > 180000)
    throw new HubError(
      400,
      "PUBLICATION_SIZE",
      "Материалы слишком большие. Опубликуй их несколькими частями.",
    );
  return { items, fingerprint: createHash("sha256").update(encoded).digest("hex") };
}
