import assert from "node:assert/strict";
import test from "node:test";
import { prepareSession } from "../ops/gpt/browser-session.mjs";

function fixture(ready = false) {
  let current = ready,
    commands = 0,
    busy = false;
  const page = { url: () => "https://chatgpt.com/", evaluate: async () => current };
  return {
    options: {
      activePage: async () => page,
      health: async () => ({
        activeRequests: busy ? [{}] : [],
        activeClient: { ready: true, pageReady: true, url: page.url() },
      }),
      command: async () => {
        commands++;
        current = true;
        return false;
      },
    },
    get commands() {
      return commands;
    },
    setBusy: () => (busy = true),
  };
}
test("an already-empty new GPT chat needs no repeated native navigation", async () => {
  const f = fixture(true);
  assert.deepEqual(await prepareSession(f.options), { ok: true });
  assert.equal(f.commands, 0);
});
test("a lost navigation acknowledgement succeeds only after the intended page is proven ready", async () => {
  const f = fixture();
  assert.deepEqual(await prepareSession(f.options), { ok: true });
  assert.equal(f.commands, 1);
});
test("GPT session preparation does not navigate during active work or accept invalid conversation targets", async () => {
  const f = fixture();
  f.setBusy();
  await assert.rejects(prepareSession(f.options), /GPT_BUSY/);
  assert.equal(f.commands, 0);
  for (const id of ["", "https://foreign.example", "../other"]) {
    await assert.rejects(prepareSession({ ...f.options, sessionId: id }), /GPT_SESSION_INVALID/);
  }
  assert.equal(f.commands, 0);
});

test("an unproved new-chat transition fails without repeating the navigation command", async () => {
  const f = fixture();
  let calls = 0;
  await assert.rejects(
    prepareSession({
      ...f.options,
      command: async () => {
        calls++;
        return false;
      },
    }),
    /GPT_SESSION_NOT_CONFIRMED/,
  );
  assert.equal(calls, 1);
});
