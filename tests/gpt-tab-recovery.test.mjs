import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { createTabRecovery, readTabLease } from "../ops/gpt/browser-recovery.mjs";

const reason = "Content runtime did not prove request cleanup before the release deadline";
function fixture() {
  let clock = 0,
    opened = 0,
    closed = 0,
    navigated = 0,
    current = 1,
    checks = 0;
  const clients = [
    null,
    ...[1, 2].map((id) => ({
      id: String(id),
      browserTabId: id,
      contentEpoch: "epoch-" + id,
      url: "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111",
      ready: true,
      pageReady: true,
      tabObservation: { generation: { state: "stopped" }, composer: { ready: true } },
    })),
  ];
  const state = {
    known: true,
    contentEpoch: "epoch-1",
    pending: false,
    lease: { leaseId: "lease", status: "quarantined", quarantineReason: reason },
  };
  const f = { state, clients, draft: false, busy: false, loaded: true, onOpen: null };
  const old = {
    url: () => clients[1].url,
    close: async () => {
      closed++;
      current = 2;
    },
  };
  const replacement = {
    url: () => (navigated ? clients[2].url : "about:blank"),
    goto: async (url) => {
      assert.equal(url, clients[1].url);
      navigated++;
    },
    close: async () => {
      closed++;
    },
  };
  f.options = {
    preserveEditors: async () => {},
    context: {
      pages: () => [old],
      newPage: async () => {
        opened++;
        f.onOpen?.();
        return replacement;
      },
    },
    health: async () => {
      checks++;
      return { ok: true, activeRequests: f.busy ? [{}] : [], activeClient: clients[current] };
    },
    readLease: async (c) =>
      c.browserTabId === 1
        ? state
        : { known: true, pending: false, lease: f.loaded ? null : state.lease },
    documentIdle: async () => !f.draft,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    timeoutMs: 500,
  };
  f.counts = () => ({ opened, closed, navigated, checks });
  return f;
}

test("quarantined idle tab is replaced once at the same native URL, without a prompt or lease mutation", async () => {
  const f = fixture(),
    recover = createTabRecovery(f.options);
  const before = structuredClone(f.state);
  const a = recover(),
    b = recover();
  assert.equal(a, b);
  assert.deepEqual(await a, { recovered: true });
  assert.deepEqual(f.counts(), { opened: 1, closed: 1, navigated: 1, checks: 4 });
  assert.deepEqual(f.state, before);
  assert.deepEqual(await recover(), { recovered: false });
});

test("healthy, active or unverified browser state never discards a tab", async () => {
  for (const change of [
    (f) => {
      f.state.lease = null;
    },
    (f) => {
      f.state.lease.status = "executing";
    },
  ]) {
    const f = fixture();
    change(f);
    assert.deepEqual(await createTabRecovery(f.options)(), { recovered: false });
    assert.equal(f.counts().opened, 0);
  }
  for (const change of [
    (f) => {
      f.busy = true;
    },
    (f) => {
      f.draft = true;
    },
    (f) => {
      f.state.pending = true;
    },
    (f) => {
      f.state.known = false;
    },
    (f) => {
      f.state.lease.quarantineReason = "unknown submission";
    },
    (f) => {
      f.state.contentEpoch = "stale";
    },
    (f) => {
      f.clients[1].url = "https://foreign.example/";
    },
    (f) => {
      f.clients[1].tabObservation.generation.state = "generating";
    },
    (f) => {
      f.clients[1].tabObservation.composer.ready = false;
    },
  ]) {
    const f = fixture();
    change(f);
    await assert.rejects(createTabRecovery(f.options)(), /GPT_/);
    assert.equal(f.counts().opened, 0);
  }
});

test("work beginning during replacement preparation wins; old tab is preserved", async () => {
  const f = fixture();
  f.onOpen = () => {
    f.busy = true;
  };
  await assert.rejects(createTabRecovery(f.options)(), /GPT_UI_ATTENTION/);
  assert.equal(f.counts().navigated, 0);
  assert.equal(f.counts().closed, 1); // Only the empty replacement.
});

test("replacement timeout keeps the new document and never repeats navigation", async () => {
  const f = fixture();
  f.loaded = false;
  await assert.rejects(createTabRecovery(f.options)(), /GPT_RECOVERY_UNVERIFIED/);
  assert.equal(f.counts().opened, 1);
  assert.equal(f.counts().navigated, 1);
  assert.equal(f.counts().closed, 1);
});

test("failed writing-block backup preserves the original document", async () => {
  const f = fixture();
  f.options.preserveEditors = async () => {
    throw Error("DISK_FULL");
  };
  await assert.rejects(createTabRecovery(f.options)(), /DISK_FULL/);
  assert.equal(f.counts().closed, 0);
  assert.equal(f.counts().opened, 0);
});

test("pinned extension inspection reads only the selected tab and retains unknown effects as blockers", async () => {
  const row = {
    schemaVersion: 6,
    contentEpoch: "e",
    lease: { status: "quarantined" },
    commands: {},
    effects: {},
    downloads: {},
  };
  let key;
  const ctx = {
    serviceWorkers: () => [
      {
        url: () => "chrome-extension://fixture/background.js",
        evaluate: async (fn, k) => {
          key = k;
          return vm.runInNewContext("(" + fn.toString() + ")(key)", {
            key: k,
            chrome: { storage: { session: { get: async () => ({ [k]: row }) } } },
          });
        },
      },
    ],
  };
  assert.equal((await readTabLease(ctx, { browserTabId: 42 })).pending, false);
  assert.equal(key, "chatgptBridgeV6:tab:42");
  for (const [kind, item] of [
    ["commands", { status: "dispatched" }],
    ["effects", { status: "uncertain" }],
    ["downloads", { status: "bound" }],
  ]) {
    row[kind] = { one: item };
    assert.equal((await readTabLease(ctx, { browserTabId: 42 })).pending, true);
    row[kind] = {};
  }
  row.schemaVersion = 7;
  assert.equal((await readTabLease(ctx, { browserTabId: 42 })).known, false);
  await assert.rejects(readTabLease(ctx, { browserTabId: "42" }), /UNVERIFIED/);
});
