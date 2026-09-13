import { createHash } from "node:crypto";
import { HubError } from "@codex-web/shared";
import { z } from "zod";
import type { createApp } from "./app.js";
import type { TeamConsultations } from "./team-consultations.js";
import type { TeamLinks } from "./team-links.js";

export function attachTeamRelayTools(
  actor: string,
  runtime: Awaited<ReturnType<typeof createApp>>,
  links: TeamLinks,
  consultations: TeamConsultations,
) {
  const original = runtime.sessions.relayTool;
  const output = (v: unknown, success = true) => ({
    success,
    contentItems: [{ type: "inputText", text: JSON.stringify(v) }],
  });
  runtime.sessions.relayTool = async (thread, request) => {
    if (request.params.tool !== "project_relays") return original?.(thread, request) ?? null;
    try {
      links.projects.registry.active(actor);
      if (
        !thread.activeTurnId ||
        request.params.turnId !== thread.activeTurnId ||
        !(await runtime.sessions.owns(thread.id))
      )
        throw new HubError(409, "RELAY_TURN_CHANGED", "Исходный ход больше не активен.");
      const latest = runtime.sessions.thread(thread.id);
      if (latest.activeTurnId !== request.params.turnId || !latest.activeTurnId)
        throw new HubError(409, "RELAY_TURN_CHANGED", "Исходный ход изменился.");
      const input = z
        .discriminatedUnion("action", [
          z.object({ action: z.literal("list") }).strict(),
          z
            .object({
              action: z.literal("request"),
              linkId: z.string().uuid(),
              kind: z.enum(["consult", "work"]),
              title: z.string().min(1).max(160),
              question: z.string().min(1).max(12000),
            })
            .strict(),
        ])
        .parse(request.params.arguments);
      if (
        input.action === "request" &&
        consultations.participating(actor, thread.id, latest.activeTurnId)
      )
        throw new HubError(
          409,
          "TEAM_CONSULT_ROOT_LIMIT",
          "Этот ход уже участвует в обмене. Верни structured decision вместо нового обмена.",
        );
      const association = links.projects.association(actor, thread.projectId);
      if (input.action === "list") {
        const response = await original?.(thread, request);
        links.projects.registry.active(actor);
        const extra: unknown[] = [];
        if (association)
          for (const offset of [0, 30, 60, 90])
            for (const link of links.page(actor, association.id, offset).items) {
              try {
                const permitted = links.permitted(actor, association.id, link.id, "consult");
                extra.push({
                  id: link.id,
                  project: permitted.target.title,
                  owner: permitted.target.ownerName,
                  depth: link.policy.depth,
                  autoConsult: link.policy.automatic,
                  shared: true,
                });
              } catch {
                /* Only accepted and authorized directions belong in the model's directory. */
              }
            }
        if (!extra.length) return response ?? output([]);
        const first = Array.isArray(response?.contentItems)
          ? (response.contentItems[0] as { text?: string })
          : undefined;
        let own: unknown = [];
        try {
          own = JSON.parse(first?.text ?? "[]");
        } catch {}
        return output([...(Array.isArray(own) ? own : []), ...extra]);
      }
      if (!links.db.prepare("SELECT 1 FROM team_links WHERE id=?").get(input.linkId))
        return original?.(thread, request) ?? null;
      if (!association) throw new HubError(404, "TEAM_LINK_MISSING", "Связь недоступна.");
      const callId = z.string().min(1).max(200).parse(request.params.callId);
      const hash = createHash("sha256")
        .update(JSON.stringify([actor, thread.id, latest.activeTurnId, callId]))
        .digest("hex");
      const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
      const { action: _action, ...body } = input;
      const v = consultations.create(
        actor,
        id,
        { ...body, projectId: association.id },
        { threadId: thread.id, turnId: latest.activeTurnId },
      );
      return output({ id: v.id, state: v.state, limit: v.limit });
    } catch (e) {
      return output(
        {
          error: e instanceof HubError ? e.code : "INVALID_RELAY_REQUEST",
          message:
            e instanceof HubError ? e.message : "Используй разрешённую связь и объявленные поля.",
        },
        false,
      );
    }
  };
}
