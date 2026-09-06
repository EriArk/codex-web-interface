import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { QueueService } from "../apps/hub/dist/queue.js";
import { Sessions } from "../apps/hub/dist/sessions.js";
import { Store } from "../apps/hub/dist/store.js";
import { configSchema, HubError } from "../packages/shared/dist/index.js";
import { capabilityReply } from "./fixtures.mjs";

class Rpc extends EventEmitter {
  closed = false;
  queue = [];
  calls = [];
  loseSteer = false;
  deleteLost = false;
  async initialize() {
    return {};
  }
  async request(method, p) {
    this.calls.push({ method, p });
    const caps = capabilityReply(method);
    if (caps) return caps;
    if (method === "account/read") return { account: {} };
    if (method === "thread/start") return { thread: { id: randomUUID() } };
    if (method === "turn/start") {
      const turn = { id: randomUUID(), status: "inProgress" };
      this.emit("notification", "turn/started", { threadId: p.threadId, turn });
      return { turn };
    }
    if (method === "thread/queue/list") return { data: this.queue };
    if (method === "thread/queue/add") {
      const q = { id: randomUUID(), clientUserMessageId: p.clientUserMessageId, input: p.input };
      this.queue.push(q);
      return { queuedSubmission: q };
    }
    if (method === "thread/queue/update") {
      const q = this.queue.find((q) => q.id === p.queuedSubmissionId);
      q.input = p.input;
      return { queuedSubmission: q };
    }
    if (method === "thread/queue/delete") {
      if (this.deleteLost) {
        this.queue = [];
        return { deleted: false };
      }
      const before = this.queue.length;
      this.queue = this.queue.filter((q) => q.id !== p.queuedSubmissionId);
      return { deleted: before !== this.queue.length };
    }
    if (method === "turn/steer") {
      if (this.loseSteer) throw new HubError(504, "CODEX_REQUEST_TIMEOUT", "Unconfirmed");
      return { turnId: p.expectedTurnId };
    }
    return {};
  }
  close() {
    this.closed = true;
  }
}
async function setup() {
  const root = mkdtempSync(join(tmpdir(), "codex-queue-"));
  const config = configSchema.parse({
    hub: {
      publicBaseUrl: "https://example.test",
      databasePath: join(root, "app.db"),
      resultsPath: join(root, "results"),
    },
    auth: {},
    machines: [{ id: "pc", name: "PC", type: "local-linux", codex: { command: "codex" } }],
    projects: [{ id: "p", name: "P", machineId: "pc", workingDirectory: root }],
  });
  const store = new Store(config.hub.databasePath),
    rpc = new Rpc(),
    sessions = new Sessions(config, store, () => rpc),
    queue = new QueueService(sessions, store);
  const t = await sessions.create("p", "Queue test");
  await sessions.startTurn(t.id, "Initial");
  return {
    store,
    rpc,
    sessions,
    queue,
    t,
    close: async () => {
      await sessions.close();
      store.close();
      rmSync(root, { recursive: true });
    },
  };
}
test("native queue edits preserve images, survives service recreation and steers once with the exact active turn", async () => {
  const f = await setup();
  try {
    const { queue, t, rpc, store, sessions } = f;
    const item = await queue.add(t.id, "Next", [], randomUUID());
    rpc.queue[0].input.push({ type: "localImage", path: "/private/image.jpg" });
    let q = (await queue.list(t.id)).items[0];
    await queue.change(t.id, q.id, q.revision, "edit", "Edited");
    assert.equal(rpc.queue[0].input[1].path, "/private/image.jpg");
    await assert.rejects(queue.change(t.id, q.id, q.revision, "delete"), { code: "QUEUE_CHANGED" });
    q = (await new QueueService(sessions, store).list(t.id)).items[0];
    assert.equal(q.text, "Edited");
    assert(!JSON.stringify(q).includes("/private"));
    const turn = store.thread(t.id).activeTurnId;
    await queue.change(t.id, q.id, q.revision, "steer", undefined, turn);
    assert.equal(rpc.queue.length, 0);
    const steer = rpc.calls.find((c) => c.method === "turn/steer");
    assert.equal(steer.p.expectedTurnId, turn);
    assert.equal(steer.p.input[1].type, "localImage");
    assert.equal((await queue.list(t.id)).items[0].state, "steered");
    await assert.rejects(queue.change(t.id, q.id, q.revision, "delete"), {
      code: "MESSAGE_ACCEPTED",
    });
    const clientId = rpc.calls.find((c) => c.method === "turn/steer").p.clientUserMessageId;
    rpc.emit("notification", "item/completed", {
      threadId: t.codexThreadId,
      turnId: turn,
      item: {
        id: randomUUID(),
        clientId,
        type: "userMessage",
        content: [{ type: "text", text: "Edited" }],
      },
    });
    assert.equal((await queue.list(t.id)).items.length, 0);
    assert(store.history(t.id).messages.some((m) => m.id === clientId));
    await assert.rejects(queue.change(t.id, q.id, q.revision, "steer", undefined, turn), {
      code: "QUEUE_CHANGED",
    });
    assert.equal(rpc.calls.filter((c) => c.method === "turn/steer").length, 1);
    assert(item.id);
  } finally {
    await f.close();
  }
});
test("external writer and completion race preserve queue; lost acknowledgement preserves recovery without automatic resend", async () => {
  const f = await setup();
  try {
    let q = await f.queue.add(f.t.id, "Do later", [], randomUUID());
    const turn = f.store.thread(f.t.id).activeTurnId;
    await assert.rejects(f.queue.change(f.t.id, q.id, q.revision, "steer", undefined, "old-turn"), {
      code: "TURN_CHANGED",
    });
    assert.equal(f.rpc.queue.length, 1);
    const owns = f.sessions.owns.bind(f.sessions);
    f.sessions.owns = async () => false;
    await assert.rejects(f.queue.change(f.t.id, q.id, q.revision, "steer", undefined, turn), {
      code: "THREAD_IN_USE",
    });
    f.sessions.owns = owns;
    f.rpc.deleteLost = true;
    await assert.rejects(f.queue.change(f.t.id, q.id, q.revision, "steer", undefined, turn), {
      code: "QUEUE_CHANGED",
    });
    assert.equal(f.rpc.calls.filter((c) => c.method === "turn/steer").length, 0);
    assert.equal((await f.queue.list(f.t.id)).items.length, 0);
    f.rpc.deleteLost = false;
    q = await f.queue.add(f.t.id, "Keep this text", [], randomUUID());
    f.rpc.loseSteer = true;
    await assert.rejects(f.queue.change(f.t.id, q.id, q.revision, "steer", undefined, turn), {
      code: "CODEX_REQUEST_TIMEOUT",
    });
    const recovered = await new QueueService(f.sessions, f.store).list(f.t.id);
    assert.equal(recovered.items[0].state, "unknown");
    assert.equal(recovered.items[0].text, "Keep this text");
    assert.equal(f.rpc.queue.length, 0);
    await f.queue.change(f.t.id, q.id, q.revision, "edit", "Manual recovery");
    const edited = (await f.queue.list(f.t.id)).items[0];
    await f.queue.change(f.t.id, q.id, edited.revision, "restore");
    assert.equal(f.rpc.queue[0].input[0].text, "Manual recovery");
  } finally {
    await f.close();
  }
});
test("native queued user events become conversation messages once and retain attachment identities", async () => {
  const f = await setup();
  try {
    const threadId = f.t.codexThreadId,
      turnId = f.store.thread(f.t.id).activeTurnId,
      clientId = randomUUID();
    const item = {
      type: "userMessage",
      id: "native-item",
      clientId,
      content: [{ type: "text", text: "Queued input" }],
    };
    f.rpc.emit("notification", "item/started", { threadId, turnId, item });
    f.rpc.emit("notification", "item/completed", { threadId, turnId, item });
    assert.equal(f.store.history(f.t.id).messages.filter((m) => m.id === clientId).length, 1);
    assert.equal(f.store.history(f.t.id).messages.at(-1).text, "Queued input");
  } finally {
    await f.close();
  }
});

test("queue attachment metadata exists before native auto-start; a lost enqueue acknowledgement reconciles without a duplicate", async () => {
  const f = await setup();
  try {
    const file = await f.sessions.attachments.put(
      f.t.id,
      "note.txt",
      Buffer.from("Queue attachment fixture"),
    );
    const original = f.rpc.request.bind(f.rpc);
    f.rpc.request = async (method, p) => {
      if (method === "thread/queue/add") {
        const response = await original(method, p);
        const bound = f.sessions.attachments.get(file.id);
        assert.equal(bound.messageId, p.clientUserMessageId);
        throw new HubError(504, "CODEX_REQUEST_TIMEOUT", "Lost enqueue acknowledgement");
      }
      return original(method, p);
    };
    await assert.rejects(f.queue.add(f.t.id, "Keep attachment", [file.id], randomUUID()), {
      code: "CODEX_REQUEST_TIMEOUT",
    });
    const list = await f.queue.list(f.t.id);
    assert.equal(list.items.length, 1);
    assert.equal(list.items[0].state, "queued");
    assert.equal(list.items[0].attachments[0].id, file.id);
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM queue_transfers").get().n, 0);
    assert.equal(f.rpc.calls.filter((c) => c.method === "thread/queue/add").length, 1);
  } finally {
    await f.close();
  }
});

test("failed attachment staging preserves draft and releases both the queue and idempotency key", async () => {
  const f = await setup();
  try {
    const file = await f.sessions.attachments.put(
      f.t.id,
      "test.txt",
      Buffer.from("staging recovery"),
    );
    const { unlink } = await import("node:fs/promises");
    await unlink(join(f.sessions.attachments.root, file.id + ".bin"));
    const key = randomUUID(),
      body = { text: "Keep this", attachments: [file.id] };
    await assert.rejects(
      f.store.once("queue:" + f.t.id, key, body, () =>
        f.queue.add(f.t.id, body.text, body.attachments, key),
      ),
    );
    assert.equal(f.rpc.calls.filter((c) => c.method === "thread/queue/add").length, 0);
    assert.equal(f.sessions.attachments.pending(f.t.id)[0].messageId, null);
    assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM commands WHERE key=?").get(key).n, 0);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(f.sessions.attachments.root, file.id + ".bin"), "staging recovery");
    await f.store.once("queue:" + f.t.id, key, body, () =>
      f.queue.add(f.t.id, body.text, body.attachments, key),
    );
    await f.store.once("queue:" + f.t.id, key, body, () =>
      f.queue.add(f.t.id, body.text, body.attachments, key),
    );
    assert.equal(f.rpc.calls.filter((c) => c.method === "thread/queue/add").length, 1);
  } finally {
    await f.close();
  }
});
