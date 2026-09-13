import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TeamConsultations } from "../apps/hub/dist/team-consultations.js";
import { TeamLinks } from "../apps/hub/dist/team-links.js";
import { TeamProjects } from "../apps/hub/dist/team-projects.js";
import { attachTeamRelayTools } from "../apps/hub/dist/team-relay-tools.js";
import { TeamStore } from "../apps/hub/dist/team-store.js";
import { handoffFixture, settings } from "./handoff-fixture.mjs";

export async function fixture(t, automatic = true, depth = 2) {
  const root = await mkdtemp(join(tmpdir(), "cw-consult-team-")),
    natives = [];
  for (const name of ["owner", "friend"]) {
    const folder = join(root, name);
    await mkdir(folder);
    const f = await handoffFixture(undefined, undefined, {
      configure: (c) => {
        c.machines[0].type = "local-linux";
        c.machines[0].allowedProjectRoots = [folder];
        c.projects[0].workingDirectory = folder;
      },
    });
    f.store.setPreferences({ machineClients: { pc: "web" } });
    f.store.setThreadSettings(f.thread.id, settings);
    f.projectWork.context.adopt({ client: "codex", projectId: "project", name }, f.thread.id);
    natives.push(f);
  }
  const [owner, friend] = natives,
    registry = new TeamStore(join(root, "team.db"), owner.sessions.config, owner.store),
    ownerId = registry.ownerId,
    invitation = registry.invite(ownerId, "Друг"),
    friendId = registry.accept(invitation.token, "friend", "Друг", "fixture-hash", 10).id,
    projects = new TeamProjects(registry),
    links = new TeamLinks(projects),
    a = randomUUID(),
    b = randomUUID(),
    linkId = randomUUID();
  for (const [user, id, title] of [
    [ownerId, a, "Engine"],
    [friendId, b, "Game"],
  ]) {
    projects.create(user, id, { title, visibility: "private", repository: null });
    projects.bind(
      user,
      id,
      randomUUID(),
      { revision: 0, personalProjectId: "project" },
      { machineId: "pc", repository: null },
    );
  }
  links.propose(ownerId, linkId, {
    projectId: a,
    userId: friendId,
    purpose: "Согласовать API",
    policy: { direction: "both", consult: true, bridge: true, automatic, depth },
  });
  links.answer(friendId, linkId, randomUUID(), { revision: 1, accept: true, projectId: b });
  const personal = async (id) => {
    registry.active(id);
    if (![ownerId, friendId].includes(id)) throw Error("No fallback");
    return { runtime: id === ownerId ? owner : friend };
  };
  let blocked = false;
  const authorize = () => {
    if (blocked) throw Error("Maintenance");
  };
  let service = new TeamConsultations(links, personal, authorize);
  const count = (f) => f.calls.filter((c) => c.method === "turn/start").length;
  const create = (extra = {}, origin) =>
    service.create(
      ownerId,
      randomUUID(),
      {
        projectId: a,
        linkId,
        title: "Общий API",
        question: "Какой формат состояния?",
        kind: "consult",
        ...extra,
      },
      origin,
    );
  const complete = (f, decision = "resolved", summary = "PUBLIC_ANSWER", question = "") => {
    const turnId = f.store.thread(f.thread.id).activeTurnId;
    assert(turnId);
    f.rpc.emit("notification", "item/completed", {
      threadId: f.thread.codexThreadId,
      turnId,
      item: {
        id: randomUUID(),
        type: "agentMessage",
        phase: "final_answer",
        text: JSON.stringify({ decision, summary, question }),
      },
    });
    f.finishTurn();
  };
  t.after(async () => {
    await service.close();
    await Promise.all(natives.map((f) => f.close()));
    registry.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    personal,
    authorize,
    owner,
    friend,
    ownerId,
    friendId,
    registry,
    projects,
    links,
    a,
    b,
    linkId,
    get service() {
      return service;
    },
    create,
    count,
    complete,
    block: (v) => {
      blocked = v;
    },
    restart: async () => {
      await service.close();
      service = new TeamConsultations(links, personal, authorize);
    },
  };
}
