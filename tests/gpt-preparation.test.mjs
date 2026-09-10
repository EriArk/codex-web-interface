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
      clearOverlays: async () => {},
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
      timeoutMs: 100,
      command: async () => {
        calls++;
        return false;
      },
    }),
    /GPT_SESSION_NOT_CONFIRMED/,
  );
  assert.equal(calls, 1);
});

test("navigation survives context destruction and delayed extension reattachment without replay", async () => {
  let clock = 0,
    commands = 0,
    observations = 0,
    clearCalls = 0;
  const page = {
    url: () => "https://chatgpt.com/",
    evaluate: async () => {
      observations++;
      if (observations === 2) throw Error("Execution context was destroyed");
      return commands > 0 && clock >= 12000;
    },
  };
  const result = await prepareSession({
    activePage: async () => page,
    health: async () => ({
      activeRequests: [],
      activeClient: { ready: clock < 100 || clock >= 10000, pageReady: true, url: page.url() },
    }),
    clearOverlays: async () => {
      clearCalls++;
    },
    command: async () => {
      commands++;
      throw Error("Lost acknowledgement");
    },
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(commands, 1);
  assert(clearCalls > 1);
});

test("an unavailable initial tab is observed until rebound before the single navigation", async () => {
  const f = fixture();
  let clock = 0,
    probes = 0;
  const getPage = f.options.activePage;
  assert.deepEqual(
    await prepareSession({
      ...f.options,
      activePage: async () => {
        if (++probes < 3) throw Error("GPT_ACTIVE_TAB_UNAVAILABLE");
        return getPage();
      },
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    }),
    { ok: true },
  );
  assert.equal(f.commands, 1);
});

test("owner dialog or newly active native generation stops preparation without extra commands", async () => {
  const f = fixture();
  await assert.rejects(
    prepareSession({
      ...f.options,
      clearOverlays: async () => {
        throw Error("GPT_UI_ATTENTION");
      },
    }),
    /GPT_UI_ATTENTION/,
  );
  assert.equal(f.commands, 0);
  await assert.rejects(
    prepareSession({
      ...f.options,
      command: async () => {
        f.setBusy();
        return true;
      },
    }),
    /GPT_BUSY/,
  );
});
