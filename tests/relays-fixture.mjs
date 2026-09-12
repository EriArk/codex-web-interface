import { randomUUID } from "node:crypto";
import { handoffFixture } from "./handoff-fixture.mjs";
export async function relayFixture(origin) {
  const f = await handoffFixture(origin);
  await f.release();
  f.sessions.config.projects.push({
    id: "target",
    name: "Target",
    machineId: "pc",
    workingDirectory: "C:/Target",
    enabled: true,
  });
  const target = f.store.createThread("target", randomUUID(), "Target chat");
  const service = f.app.projectRelays;
  service.actions.context.adopt(service.scope("project"), f.thread.id);
  service.actions.context.adopt(service.scope("target"), target.id);
  const link = service.writeLink(randomUUID(), {
    sourceId: "project",
    targetId: "target",
    depth: 3,
    autoConsult: true,
    revision: 0,
  });
  const create = (patch = {}, model = false) =>
    service.create(
      randomUUID(),
      {
        linkId: link.id,
        sourceId: "project",
        kind: "consult",
        title: "Interface compatibility",
        question: "Check the API contract",
        ...patch,
      },
      model,
    );
  const complete = (step, decision = "resolved", question = "", summary = "Compatible") => {
    const thread = f.store.thread(step.threadId);
    f.rpc.emit("notification", "item/completed", {
      threadId: thread.codexThreadId,
      turnId: step.turnId,
      item: {
        type: "agentMessage",
        id: randomUUID(),
        phase: "final_answer",
        text: JSON.stringify({ decision, summary, question }),
      },
    });
    f.rpc.emit("notification", "turn/completed", {
      threadId: thread.codexThreadId,
      turn: { id: step.turnId, status: "completed" },
    });
  };
  return { ...f, target, service, link, create, complete };
}
