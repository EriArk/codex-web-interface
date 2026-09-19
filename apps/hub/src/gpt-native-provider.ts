import {
  type GptConnection,
  type GptModels,
  gptConnectionMessages,
  HubError,
} from "@codex-web/shared";
import type { NativeGptReadClient } from "./gpt-native.js";

/** Explicit integration admission, injected by the private owner runtime. It cannot
 * be selected by a browser request or inherited by another user's workspace.
 * Until parity admission, sends remain restricted by the supervisor's canary list. */
export interface NativeGptWorkspace {
  client: Pick<
    NativeGptReadClient,
    | "projectContent"
    | "projectMutation"
    | "reconcileProject"
    | "libraryMutation"
    | "status"
    | "models"
    | "pins"
    | "catalog"
    | "projects"
    | "project"
    | "conversationGraph"
    | "download"
    | "prepareDispatch"
    | "dispatchText"
    | "reconcileDispatch"
    | "stopDispatch"
    | "uploadFile"
    | "uploadFilePath"
  >;
  projects?: ReadonlySet<string>;
  conversations: ReadonlySet<string>;
  creationKeys: ReadonlySet<string>;
}
const unavailable = () =>
  new HubError(
    409,
    "GPT_NATIVE_NOT_READY",
    "Это действие ещё не подключено к новому клиенту GPT. Открой клиент в настройках подключения.",
  );
export class NativeGptProvider {
  constructor(readonly workspace: NativeGptWorkspace) {}
  assertSubmission(id: string, nativeId: string | null) {
    if (
      !(nativeId === null
        ? this.workspace.creationKeys.has(id)
        : this.workspace.conversations.has(nativeId))
    )
      throw unavailable();
  }
  async connection(): Promise<GptConnection> {
    const status = await this.workspace.client.status();
    // Status alone proves the supervisor is alive, not that the account is usable.
    if (!status.manual) await this.workspace.client.models();
    const state = status.manual ? "attention" : "healthy";
    return {
      configured: true,
      state,
      message: gptConnectionMessages[state],
      canRead: !status.manual,
      canSend: !status.manual,
      activeJobs: 0,
      unknownJobs: 0,
      connectUrl: "/gpt-connect?runtime=native",
    };
  }
  async models(): Promise<GptModels> {
    const { versions } = await this.workspace.client.models();
    const usable = versions.filter((v) => v.enabled && v.presets.some((p) => p.available));
    if (!usable.length) throw unavailable();
    const effortsByModel = Object.fromEntries(
      usable.map((v) => [
        v.id,
        v.presets.filter((p) => p.available).map((p) => ({ id: String(p.id), label: p.label })),
      ]),
    );
    const first = usable[0]!;
    return {
      models: usable.map((v) => ({ id: v.id, label: v.label })),
      efforts: effortsByModel[first.id]!,
      effortsByModel,
      currentModel: first.id,
      currentEffort: effortsByModel[first.id]![0]!.id,
    };
  }
  async json(path: string, body?: unknown): Promise<Record<string, any>> {
    if (body !== undefined) throw unavailable();
    const url = new URL(path, "http://native.invalid"),
      q = url.searchParams,
      client = this.workspace.client;
    if (url.pathname === "/conversation") return client.conversationGraph(q.get("id") ?? "");
    if (url.pathname === "/models") return this.models();
    if (url.pathname === "/pins") {
      const { items } = await client.pins();
      return {
        items: items.map((p) => ({
          item_type: p.kind === "thread" ? "conversation" : "project",
          item:
            p.kind === "thread"
              ? { id: p.id, title: p.title, update_time: p.updatedAt / 1000, gizmo_id: p.projectId }
              : { gizmo: { id: p.id, display: { name: p.title } } },
        })),
      };
    }
    if (url.pathname === "/catalog") {
      const offset = Number(q.get("offset") ?? 0),
        page = await client.catalog(offset, q.get("archived") === "1");
      return {
        offset,
        total: page.nextOffset === null ? offset + page.items.length : page.nextOffset + 1,
        items: page.items.map((c) => ({
          id: c.id,
          title: c.title,
          update_time: c.updatedAt / 1000,
          gizmo_id: c.projectId,
        })),
      };
    }
    if (url.pathname === "/projects") {
      const projects = [],
        cursors = new Set<string>();
      let cursor: string | null = null;
      // Existing shared contract is one bounded project list. Fail visibly instead
      // of silently hiding projects if an upstream cursor loops/exceeds its budget.
      for (let page = 0; page < 10; page++) {
        const result = await client.projects(cursor);
        projects.push(...result.items);
        if (result.cursor === null)
          return {
            items: projects.map((p) => ({
              gizmo: { id: p.id, display: { name: p.name } },
              conversations: {
                items: p.conversations.map((c) => ({
                  id: c.id,
                  title: c.title,
                  update_time: c.updatedAt / 1000,
                })),
              },
            })),
          };
        if (cursors.has(result.cursor)) break;
        cursors.add(result.cursor);
        cursor = result.cursor;
      }
      throw new HubError(
        503,
        "GPT_NATIVE_PROJECT_PAGING",
        "Не удалось дочитать список проектов GPT. Повтори загрузку.",
      );
    }
    if (url.pathname === "/project") {
      const p = await client.project(q.get("id") ?? "");
      return { gizmo: { id: p.id, display: { name: p.name } } };
    }
    throw unavailable();
  }
}
