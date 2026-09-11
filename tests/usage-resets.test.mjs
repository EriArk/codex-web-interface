import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { normalizeLimits, normalizeResetCredits } from "../apps/hub/dist/usage.js";
import { UsageResets } from "../apps/hub/dist/usage-resets.js";
import { limits, usageFixture } from "./usage-resets-fixture.mjs";

const endpoint = "/api/machines/pc/limits/resets";
test("reset projection preserves opaque IDs, count-only and capped-detail semantics, omits billing and rejects malformed credits", () => {
  const raw = limits();
  raw.billing = { password: "private-secret" };
  const result = normalizeLimits(raw);
  assert.equal(result.resetCredits.credits[0].id, "opaque:/reset A");
  assert(!JSON.stringify(result).includes("private"));
  assert.deepEqual(normalizeResetCredits({ availableCount: 3 }), {
    availableCount: 3,
    credits: null,
  });
  assert.deepEqual(normalizeResetCredits({ availableCount: 3, credits: [] }), {
    availableCount: 3,
    credits: [],
  });
  assert.equal(normalizeResetCredits({ availableCount: -1 }), null);
  assert.equal(normalizeResetCredits({ availableCount: Infinity }), null);
  assert.equal(normalizeLimits({ rateLimits: raw.rateLimits }).resetCredits, null);
  const c = raw.rateLimitResetCredits.credits[0];
  const malformed = normalizeResetCredits({
    availableCount: 4,
    credits: [
      { ...c, id: "x".repeat(1025) },
      { ...c, expiresAt: "bad", title: "<b>plain text</b>\u0000" },
      { ...c, id: "other", status: "future", resetType: "paid" },
    ],
  });
  assert.equal(malformed.credits.length, 2);
  assert.equal(malformed.credits[0].status, "unknown");
  assert.equal(malformed.credits[0].title, "<b>plain text</b>");
  assert.equal(malformed.credits[1].resetType, "unknown");
});

test("explicit redemption is exact-idempotent, canonical refresh updates both meters, no native chat or desktop action", async (t) => {
  const f = await usageFixture();
  t.after(() => f.close());
  const data = await f.read();
  assert.equal(data.resetCredits.availableCount, 2);
  assert(data.resetContext);
  const body = f.body(data),
    response = await f.request("POST", endpoint, body);
  assert.equal(response.status, 200);
  assert.equal(response.data.outcome, "reset");
  assert.deepEqual(await f.request("POST", endpoint, body), response);
  assert.equal(f.state.consumes.length, 1);
  assert.deepEqual(f.state.consumes[0], { idempotencyKey: body.id, creditId: body.creditId });
  const updated = await f.read();
  assert.equal(updated.resetCredits.availableCount, 1);
  assert(updated.groups[0].windows.every((w) => w.remainingPercent === 100));
  assert.equal(f.desktopCalls.length, 0);
  assert(!f.calls.some((c) => /^(thread|turn)\//.test(c.method)));
  assert.equal((await f.request("POST", endpoint, { ...body, creditId: "other" })).status, 409);
});

test("count-only redemption omits creditId; a stale second device cannot spend the next credit", async (t) => {
  const f = await usageFixture();
  t.after(() => f.close());
  f.state.raw.rateLimitResetCredits.credits = null;
  const [a, b] = await Promise.all([f.read(), f.read()]);
  assert.equal((await f.request("POST", endpoint, f.body(a))).data.outcome, "reset");
  assert(!("creditId" in f.state.consumes[0]));
  assert.equal((await f.request("POST", endpoint, f.body(b))).status, 409);
  assert.equal(f.state.consumes.length, 1);
});

test("concurrent double-clicks and independently-confirmed devices reserve one account operation", async (t) => {
  const f = await usageFixture();
  t.after(() => f.close());
  const data = await f.read(),
    first = f.body(data),
    second = f.body(data);
  let release;
  f.state.hold = new Promise((r) => {
    release = r;
  });
  const sending = f.request("POST", endpoint, first);
  await new Promise((r) => setTimeout(r, 30));
  const duplicate = await f.request("POST", endpoint, first);
  assert.equal(duplicate.data.state, "pending");
  assert.equal((await f.request("POST", endpoint, second)).status, 409);
  release();
  await sending;
  assert.equal(f.state.consumes.length, 1);
});

test("lost native acknowledgement survives reload/restart and checks the exact original key without spending twice", async (t) => {
  const f = await usageFixture();
  t.after(() => f.close());
  const body = f.body(await f.read());
  f.state.mode = "lose-after";
  assert.equal((await f.request("POST", endpoint, body)).data.state, "unknown");
  const read = await f.read();
  assert.equal(read.resetContext, null);
  assert.equal(read.resetOperation.id, body.id);
  assert.equal(read.resetOperation.state, "unknown"); // A lower count is not proof of this attempt.
  const restarted = new UsageResets(f.sessions);
  assert.equal(restarted.get("pc", body.id).state, "unknown");
  f.state.mode = "normal";
  const result = await restarted.retry("pc", body.id);
  assert.equal(result.outcome, "alreadyRedeemed");
  assert.equal(f.state.raw.rateLimitResetCredits.availableCount, 1);
  assert.deepEqual(
    f.state.consumes.map((c) => c.idempotencyKey),
    [body.id, body.id],
  );
  assert.equal((await f.request("POST", endpoint, body)).data.outcome, "alreadyRedeemed");
});

test("restart changes pending receipts to unknown without dispatch; unresolved attempt blocks fresh keys", async (t) => {
  const f = await usageFixture();
  t.after(() => f.close());
  const data = await f.read(),
    body = f.body(data);
  f.state.mode = "unknown-before";
  await f.request("POST", endpoint, body);
  f.store.db.prepare("UPDATE usage_reset_operations SET state='pending' WHERE id=?").run(body.id);
  new UsageResets(f.sessions);
  assert.equal((await f.request("GET", endpoint + "/" + body.id)).data.state, "unknown");
  assert.equal((await f.request("POST", endpoint, { ...body, id: randomUUID() })).status, 409);
  assert.equal(f.state.consumes.length, 1);
});

test("changed account, expired credit, unavailable status and unknown reset type never call consume", async (t) => {
  for (const mutate of [
    (raw) => {
      raw.accountId = "other-account";
    },
    (raw) => {
      raw.rateLimitResetCredits.credits[0].expiresAt = 1;
    },
    (raw) => {
      raw.rateLimitResetCredits.credits[0].status = "redeeming";
    },
    (raw) => {
      raw.rateLimitResetCredits.credits[0].resetType = "paid";
    },
  ]) {
    const f = await usageFixture();
    try {
      const data = await f.read();
      mutate(f.state.raw);
      assert.equal((await f.request("POST", endpoint, f.body(data))).status, 409);
      const updated = await f.read();
      if (f.state.raw.accountId !== "other-account")
        assert.equal((await f.request("POST", endpoint, f.body(updated))).status, 409);
      assert.equal(f.state.consumes.length, 0);
    } finally {
      await f.close();
    }
  }
});

test("same-account machines share the stale-read and pending guards, different accounts are independent", async (t) => {
  const f = await usageFixture();
  t.after(() => f.close());
  f.sessions.config.machines.push({ ...f.sessions.config.machines[0], id: "pc2" });
  f.sessions.config.projects.push({
    ...f.sessions.config.projects[0],
    id: "second",
    machineId: "pc2",
  });
  const second = await f.read("pc2"),
    first = await f.read();
  await f.request("POST", endpoint, f.body(first));
  assert.equal(
    (await f.request("POST", "/api/machines/pc2/limits/resets", f.body(second))).status,
    409,
  );
  assert.equal(f.state.consumes.length, 1);
  f.state.raw = limits();
  f.state.raw.accountId = "another-account";
  const separate = await f.read("pc2");
  assert.equal(
    (await f.request("POST", "/api/machines/pc2/limits/resets", f.body(separate))).data.outcome,
    "reset",
  );
  assert.equal(f.state.consumes.length, 2);
});

test("retry on a different account stays unknown and cannot consume the new account's credit", async (t) => {
  const f = await usageFixture();
  t.after(() => f.close());
  const body = f.body(await f.read());
  f.state.mode = "unknown-before";
  await f.request("POST", endpoint, body);
  f.state.raw.accountId = "different";
  assert.equal(
    (await f.request("POST", endpoint + "/" + body.id + "/retry", { confirm: true })).status,
    409,
  );
  assert.equal(f.state.consumes.length, 1);
});

test("unsupported, no-credit, nothing-to-reset and unrecognized outcomes stay distinct", async (t) => {
  for (const mode of ["unsupported", "nothingToReset", "noCredit", "invalid"]) {
    const f = await usageFixture();
    try {
      const body = f.body(await f.read());
      f.state.mode = mode;
      const { data } = await f.request("POST", endpoint, body);
      assert.equal(data.state, mode === "invalid" ? "unknown" : "complete");
      assert.equal(data.outcome, mode === "invalid" ? null : mode);
      assert.equal(f.state.raw.rateLimitResetCredits.availableCount, 2);
    } finally {
      await f.close();
    }
  }
});

test("legacy usage works; missing account identity disables redemption without dropping meters", async (t) => {
  const f = await usageFixture();
  t.after(() => f.close());
  delete f.state.raw.rateLimitResetCredits;
  assert.equal((await f.read()).available, true);
  assert.equal((await f.read()).resetContext, undefined);
  f.state.raw = limits();
  delete f.state.raw.accountId;
  const request = f.rpc.request.bind(f.rpc);
  f.rpc.request = (method, params) =>
    method === "account/read" ? Promise.resolve({ account: null }) : request(method, params);
  const read = await f.read();
  assert.equal(read.available, true);
  assert.equal(read.resetContext, null);
  assert(read.resetUnavailable);
  f.rpc.request = (method, params) =>
    method === "account/read"
      ? Promise.resolve({ account: { type: "chatgpt", email: "same-user@example.invalid" } })
      : request(method, params);
  assert.equal((await f.read()).resetContext, null, "Email alone cannot distinguish workspaces");
});

test("authentication, CSRF, exact schema, snapshot/machine binding and expiry protect the narrow endpoint", async (t) => {
  const f = await usageFixture();
  t.after(() => f.close());
  const body = f.body(await f.read());
  assert.equal((await f.request("POST", endpoint, body, {})).status, 401);
  assert.equal(
    (
      await f.request("POST", endpoint, body, {
        cookie: f.headers.cookie,
        origin: f.headers.origin,
      })
    ).status,
    403,
  );
  assert.equal(
    (await f.request("POST", endpoint, { ...body, method: "arbitrary/rpc" })).status,
    400,
  );
  assert.equal((await f.request("POST", endpoint, { ...body, confirm: false })).status, 400);
  assert.equal((await f.request("POST", "/api/machines/other/limits/resets", body)).status, 409);
  let now = Date.now();
  const service = new UsageResets(f.sessions, () => now),
    data = await service.read("pc");
  now += 600001;
  await assert.rejects(service.consume("pc", f.body(data)), { code: "RESET_SNAPSHOT_EXPIRED" });
  assert.equal(f.state.consumes.length, 0);
});
