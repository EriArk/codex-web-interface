import { randomUUID } from "node:crypto";
import { HubError } from "../packages/shared/dist/index.js";
import { handoffFixture } from "./handoff-fixture.mjs";

export function limits() {
  return {
    accountId: "private-account-qa",
    rateLimits: {
      limitId: "codex",
      primary: { usedPercent: 80, windowDurationMins: 300, resetsAt: 2000000000 },
      secondary: { usedPercent: 63, windowDurationMins: 10080, resetsAt: 2000100000 },
    },
    rateLimitResetCredits: {
      availableCount: 2,
      credits: [
        {
          id: "opaque:/reset A",
          resetType: "codexRateLimits",
          status: "available",
          grantedAt: 1780000000,
          expiresAt: 2000000000,
          title: "Сохранённый сброс",
          description: "Обновление доступных лимитов Codex",
        },
        {
          id: "opaque:/reset B",
          resetType: "codexRateLimits",
          status: "available",
          grantedAt: 1780000000,
          expiresAt: null,
          title: null,
          description: null,
        },
      ],
    },
  };
}
export async function usageFixture(origin) {
  const f = await handoffFixture(origin);
  const state = {
    raw: limits(),
    mode: "normal",
    consumes: [],
    receipts: new Map(),
    hold: null,
    readFailure: false,
  };
  const base = f.rpc.request.bind(f.rpc);
  f.rpc.request = async (method, params) => {
    if (method === "account/rateLimits/read") {
      if (state.readFailure) throw Error("Read failed");
      return structuredClone(state.raw);
    }
    if (method === "account/read")
      return { account: { type: "chatgpt", email: "private@example.test" } };
    if (method !== "account/rateLimitResetCredit/consume") return base(method, params);
    state.consumes.push(structuredClone(params));
    if (state.hold) await state.hold;
    if (state.mode === "unsupported")
      throw new HubError(501, "CODEX_METHOD_UNSUPPORTED", "unsupported");
    if (state.mode === "unknown-before") throw Error("Acknowledgement lost before observation");
    if (state.mode === "invalid") return { outcome: "futureOutcome", secret: "never display" };
    if (state.receipts.has(params.idempotencyKey)) return { outcome: "alreadyRedeemed" };
    if (["nothingToReset", "noCredit"].includes(state.mode)) return { outcome: state.mode };
    state.receipts.set(params.idempotencyKey, true);
    state.raw.rateLimitResetCredits.availableCount--;
    if (Array.isArray(state.raw.rateLimitResetCredits.credits))
      state.raw.rateLimitResetCredits.credits = state.raw.rateLimitResetCredits.credits.filter(
        (c) => c.id !== params.creditId,
      );
    state.raw.rateLimits.primary.usedPercent = 0;
    state.raw.rateLimits.secondary.usedPercent = 0;
    if (state.mode === "lose-after") throw Error("Acknowledgement lost after redemption");
    return { outcome: "reset" };
  };
  const request = async (method, url, payload, headers = f.headers) => {
    const r = await f.app.inject({ method, url, payload, headers });
    return { status: r.statusCode, data: r.json() };
  };
  const read = async (machine = "pc") =>
    (await request("GET", `/api/machines/${machine}/limits`)).data;
  const body = (data, creditId = data.resetCredits?.credits?.[0]?.id) => ({
    id: randomUUID(),
    snapshotId: data.resetContext,
    confirm: true,
    ...(creditId === undefined ? {} : { creditId }),
  });
  return { ...f, state, request, read, body };
}
