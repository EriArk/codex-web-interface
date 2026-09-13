import { HubError, type ProjectScope } from "@codex-web/shared";
import type { createApp } from "./app.js";
import type { TeamBridges } from "./team-bridges.js";
import { publicationPreview, publicationSources } from "./team-publication.js";

type Runtime = Awaited<ReturnType<typeof createApp>>;
export type BridgeSourceKind = "note" | "plan" | "review" | "report";

export class TeamBridgeSources {
  constructor(
    readonly rooms: TeamBridges,
    private personal: (id: string) => Promise<{ runtime: Runtime }>,
  ) {}
  async list(
    actor: string,
    id: string,
    scope: ProjectScope,
    kind: BridgeSourceKind,
    offset: number,
  ) {
    this.rooms.access(actor, id, true);
    const { runtime } = await this.personal(actor);
    this.rooms.access(actor, id, true);
    return publicationSources(runtime, scope, kind, offset);
  }
  selected(actor: string, id: string, sourceId: string) {
    this.rooms.access(actor, id);
    const row = this.rooms.db
      .prepare("SELECT value FROM team_bridge_sources WHERE id=? AND bridgeId=? AND ownerId=?")
      .get(sourceId, id, actor);
    if (!row) throw new HubError(404, "BRIDGE_SOURCE_PRIVATE", "Личный источник недоступен.");
    return JSON.parse(String(row.value));
  }
  async prepare(
    actor: string,
    id: string,
    key: string,
    input: { scope: ProjectScope; kind: BridgeSourceKind; id: string },
  ) {
    this.rooms.access(actor, id, true);
    if (this.rooms.db.prepare("SELECT 1 FROM team_bridge_sources WHERE id=?").get(key)) {
      const value = this.selected(actor, id, key);
      if (JSON.stringify(input) !== JSON.stringify(value.input))
        throw new HubError(
          409,
          "BRIDGE_SOURCE_CHANGED",
          "Подтверждение относится к другому материалу.",
        );
      return { id: key, title: value.title, text: value.text, truncated: value.truncated };
    }
    const { runtime } = await this.personal(actor);
    this.rooms.access(actor, id, true);
    const snapshot = publicationPreview(runtime, actor, input.scope, [
        { kind: input.kind, id: input.id },
      ]).items[0]!,
      c = snapshot.content;
    const text =
      "description" in c
        ? c.description +
          "\n\n" +
          c.sections
            .map(
              (s) =>
                s.title +
                "\n" +
                s.items.map((i) => (i.checked ? "[x] " : "[ ] ") + i.text).join("\n"),
            )
            .join("\n\n")
        : "body" in c
          ? c.body
          : "";
    const value = {
      input,
      title: c.title,
      text: text.slice(0, 8000),
      truncated: text.length > 8000,
      snapshot,
    };
    this.rooms.projects.once(actor, "bridge.source:" + id, key, input, () => {
      this.rooms.access(actor, id, true);
      if (
        Number(
          this.rooms.db
            .prepare(
              "SELECT COALESCE(SUM(length(value)),0) n FROM team_bridge_sources WHERE ownerId=?",
            )
            .get(actor)?.n,
        ) +
          JSON.stringify(value).length >
        10 * 1024 * 1024
      )
        throw new HubError(
          409,
          "BRIDGE_SOURCE_CAPACITY",
          "Лимит сохранённых личных источников Bridge достигнут.",
        );
      this.rooms.db
        .prepare("INSERT INTO team_bridge_sources VALUES(?,?,?,?,?)")
        .run(key, id, actor, JSON.stringify(value), Date.now());
      return { id: key };
    });
    const saved = this.selected(actor, id, key);
    return { id: key, title: saved.title, text: saved.text, truncated: saved.truncated };
  }
  entry(actor: string, id: string, entryId: string) {
    this.rooms.access(actor, id);
    const row = this.rooms.db
      .prepare("SELECT value FROM team_bridge_entries WHERE bridgeId=? AND id=?")
      .get(id, entryId);
    if (!row) throw new HubError(404, "BRIDGE_SOURCE_PRIVATE", "Личный источник недоступен.");
    const e = JSON.parse(String(row.value));
    if (e.userId !== actor || !e.privateSourceId)
      throw new HubError(404, "BRIDGE_SOURCE_PRIVATE", "Личный источник недоступен.");
    return this.selected(actor, id, e.privateSourceId);
  }
}
