import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { createApp } from "../apps/hub/dist/app.js";
import { configSchema } from "../packages/shared/dist/index.js";

test("asset/reconnect bursts do not consume write or password budgets; all API budgets remain bounded", async () => {
  const origin = "https://codex.example.test",
    token = randomBytes(32).toString("base64url");
  const config = configSchema.parse({
    hub: {
      publicBaseUrl: origin,
      databasePath: ":memory:",
      resultsPath: "/tmp/codex-request-budget",
    },
    auth: { username: "owner" },
    machines: [],
    projects: [],
  });
  const { app } = await createApp(config, { setupToken: token });
  try {
    // Missing assets take the same allow-list path as files served by the web plugin.
    for (let i = 0; i < 650; i++)
      assert.notEqual((await app.inject({ url: "/assets/fixture-" + i + ".js" })).statusCode, 429);
    for (let i = 0; i < 600; i++)
      assert.equal((await app.inject({ url: "/api/health" })).statusCode, 200);
    assert.equal((await app.inject({ url: "/api/health" })).statusCode, 429);
    const enrolled = await app.inject({
      method: "POST",
      url: "/api/auth/setup",
      headers: { origin },
      payload: { token, password: randomBytes(24).toString("base64url") },
    });
    assert.equal(enrolled.statusCode, 200, "Reading cannot lock out enrollment/write requests");
    for (let i = 0; i < 5; i++)
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: "/api/auth/login",
            headers: { origin },
            payload: { password: "wrong" },
          })
        ).statusCode,
        401,
      );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/auth/login",
          headers: { origin },
          payload: { password: "wrong" },
        })
      ).statusCode,
      429,
      "Password login retains the strict five-attempt limit",
    );
  } finally {
    await app.close();
  }
});
