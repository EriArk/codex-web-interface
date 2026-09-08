import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";
import { handoffFixture } from "./handoff-fixture.mjs";

test("file frames require authentication, CSRF, iframe context and the creating session; remain bounded", async () => {
  const f = await handoffFixture();
  try {
    const post = (html, headers = f.headers) =>
      f.app.inject({ method: "POST", url: "/api/previews/file", headers, payload: { html } });
    assert.equal((await post("<p>private</p>", {})).statusCode, 401);
    assert.equal(
      (await post("<p>private</p>", { cookie: f.headers.cookie, origin: f.headers.origin }))
        .statusCode,
      403,
    );
    const created = await post("<button onclick='this.textContent=42'>Demo</button>");
    assert.equal(created.statusCode, 200);
    const url = created.json().url;
    const frameHeaders = {
      ...f.headers,
      "sec-fetch-dest": "iframe",
      "sec-fetch-site": "same-origin",
    };
    assert.equal((await f.app.inject({ url, headers: f.headers })).statusCode, 403);
    const frame = await f.app.inject({ url, headers: frameHeaders });
    assert.equal(frame.statusCode, 200);
    assert.match(frame.headers["content-security-policy"], /sandbox allow-scripts/);
    assert.match(frame.headers["content-security-policy"], /connect-src 'none'/);
    assert.doesNotMatch(frame.headers["content-security-policy"], /allow-same-origin/);
    assert.equal(frame.headers["cache-control"], "private, no-store");
    const token = randomBytes(32).toString("base64url"),
      hash = createHash("sha256").update(token).digest("hex");
    f.store.db
      .prepare("INSERT INTO sessions(tokenHash,csrf,expires) VALUES(?,?,?)")
      .run(hash, "second-session-csrf", Date.now() + 60000);
    const other = {
      ...frameHeaders,
      cookie: "__Host-codex-session=" + token,
      "x-csrf-token": "second-session-csrf",
    };
    assert.equal((await f.app.inject({ url, headers: other })).statusCode, 404);
    await f.app.inject({ method: "DELETE", url, headers: other });
    assert.equal((await f.app.inject({ url, headers: frameHeaders })).statusCode, 200);
    assert.equal((await post("я".repeat(150000))).statusCode, 413);
    await f.app.inject({ method: "DELETE", url, headers: f.headers });
    assert.equal((await f.app.inject({ url, headers: frameHeaders })).statusCode, 404);
    for (let i = 0; i < 16; i++) assert.equal((await post("<p>bounded</p>")).statusCode, 200);
    assert.equal((await post("overflow")).statusCode, 429);
  } finally {
    await f.close();
  }
});
