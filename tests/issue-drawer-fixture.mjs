import { randomUUID } from "node:crypto";
import { handoffFixture } from "./handoff-fixture.mjs";

export async function issueFixture(origin) {
  const f = await handoffFixture(origin, undefined, {
    configure(config) {
      config.projects.push({
        ...config.projects[0],
        id: "second",
        name: "Second",
        workingDirectory: "C:/Second",
      });
    },
  });
  await f.release();
  const d = f.issueDrawer,
    receipts = new Map(),
    operations = [];
  d.inspect = async (_m, root) => ({
    remote: { url: `https://github.com/me/${root.endsWith("Second") ? "second" : "first"}.git` },
  });
  const native = async (_m, _root, q) => {
    operations.push(q);
    if (q.op === "prepare") {
      const r = {
        id: q.id,
        state: "prepared",
        fingerprint: randomUUID(),
        input: q.input,
        snapshot: {
          repository: q.repository,
          repositoryId: q.repository.endsWith("second") ? 43 : 42,
          identity: { id: 7, login: "actual-user" },
          access: "write",
          issues: true,
        },
      };
      receipts.set(q.id, r);
      return structuredClone(r);
    }
    const r = receipts.get(q.id);
    if (q.op === "apply") {
      r.state = "completed";
      r.result = {
        number: operations.filter((q) => q.op === "apply").length,
        url: `https://github.com/${r.snapshot.repository}/issues/${operations.filter((q) => q.op === "apply").length}`,
      };
    }
    return structuredClone(r);
  };
  d.probe = native;
  const answer = (
    text = "## Exact issue\r\n\r\nPreserve **bytes**.\r\n",
    phase = "final_answer",
  ) => {
    const id = randomUUID();
    f.sessions.emitEvent(f.thread.id, "assistant.completed", { id, text, phase }, randomUUID());
    return {
      source: { client: "codex", threadId: f.thread.id, messageId: id, projectId: "project" },
      text,
      targetId: "project",
    };
  };
  const add = (text, targetId = "project") => d.add(randomUUID(), { ...answer(text), targetId });
  const packageItems = (items) =>
    d.prepare(
      randomUUID(),
      items.map((i) => ({ id: i.id, revision: i.revision })),
    );
  const settle = async () => {
    await d.pending;
  };
  return { ...f, d, receipts, operations, native, answer, add, packageItems, settle };
}
