import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { handoffFixture, settings } from "./handoff-fixture.mjs";

test("send-time desktop handoff reuses the rejected send key and delivers text/files once", async () => {
  const f = await handoffFixture();
  try {
    const file = await f.sessions.attachments.put(
      f.thread.id,
      "note.txt",
      Buffer.from("preserved attachment"),
    );
    const key = randomUUID(),
      body = { text: "Continue here", settings, attachments: [file.id] };
    // Even a busy desktop must offer the explicit handoff before trying to acquire its writer.
    f.store.db
      .prepare("UPDATE threads SET activitySource='external',status='running' WHERE id=?")
      .run(f.thread.id);
    for (let attempt = 0; attempt < 2; attempt++) {
      const rejected = await f.send(key, body);
      assert.equal(rejected.json().error?.code, "MACHINE_RELEASED");
      assert.equal(
        f.store.db
          .prepare("SELECT count(*) AS n FROM commands WHERE scope=?")
          .get(`turn:${f.thread.id}`).n,
        0,
      );
    }
    assert.equal(f.calls.length, 0);
    assert.equal(f.store.history(f.thread.id).messages.length, 0);
    assert.equal(f.sessions.attachments.pending(f.thread.id)[0].id, file.id);
    assert.equal(f.desktopCalls.length, 0);
    const released = await f.release();
    assert.equal(released.statusCode, 200);
    assert.equal(released.json().client, "web");
    f.store.db
      .prepare("UPDATE threads SET activitySource='hub',status='idle' WHERE id=?")
      .run(f.thread.id);
    const accepted = await f.send(key, body);
    assert.equal(accepted.statusCode, 200, accepted.body);
    assert.deepEqual((await f.send(key, body)).json(), accepted.json());
    const turns = f.calls.filter((call) => call.method === "turn/start");
    assert.equal(turns.length, 1);
    assert.equal(turns[0].params.threadId, f.thread.codexThreadId);
    assert.equal(turns[0].params.input[0].text, body.text);
    assert.equal(f.store.history(f.thread.id).messages[0].attachments[0].id, file.id);
    assert.equal(f.desktopCalls.filter((action) => action === "ForceRelease").length, 1);
    assert.equal(
      f.desktopCalls.some((action) => action.includes("Restart")),
      false,
    );
  } finally {
    await f.close();
  }
});

test("an ownership change during send preflight also preserves the original request key", async () => {
  const f = await handoffFixture();
  try {
    f.store.setPreferences({ machineClients: { pc: "web" } });
    f.sessions.externalActivity.refresh = async () => {
      f.store.setPreferences({ machineClients: { pc: "desktop" } });
    };
    const key = randomUUID(),
      body = { text: "Keep this draft", settings, attachments: [] };
    assert.equal((await f.send(key, body)).json().error.code, "MACHINE_RELEASED");
    f.sessions.externalActivity.refresh = async () => {};
    assert.equal((await f.release()).statusCode, 200);
    assert.equal((await f.send(key, body)).statusCode, 200);
    assert.equal(f.calls.filter((c) => c.method === "turn/start").length, 1);
  } finally {
    await f.close();
  }
});

test("lost native send acknowledgement stays blocked after a verified web handoff", async () => {
  const f = await handoffFixture();
  try {
    const key = randomUUID(),
      body = { text: "Do not replay me", settings, attachments: [] };
    assert.equal((await f.send(key, body)).json().error.code, "MACHINE_RELEASED");
    assert.equal((await f.release()).statusCode, 200);
    f.loseAck();
    assert.equal((await f.send(key, body)).statusCode, 500);
    assert.equal((await f.send(key, body)).json().error.code, "COMMAND_OUTCOME_UNKNOWN");
    assert.equal(f.calls.filter((c) => c.method === "turn/start").length, 1);
    assert.equal(f.store.history(f.thread.id).messages.length, 1);
    assert.equal(f.store.thread(f.thread.id).status, "unknown");
  } finally {
    await f.close();
  }
});
