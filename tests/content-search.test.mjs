import assert from "node:assert/strict";
import test from "node:test";
import { searchSnippet } from "../apps/hub/dist/content-search.js";
import { handoffFixture } from "./handoff-fixture.mjs";

test("content search is Unicode-aware, literal and bounded", () => {
  assert.match(searchSnippet("Привет, КИРИЛЛИЦА и 100%", "кириллица"), /КИРИЛЛИЦА/);
  assert.equal(searchSnippet("nothing here", "%"), null);
  assert(searchSnippet("a".repeat(2000) + "needle" + "b".repeat(2000), "needle").length <= 322);
});
test("authenticated content search paginates saved public messages, never tools or hidden phases", async () => {
  const f = await handoffFixture();
  try {
    const insert = f.store.db.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?)");
    for (let i = 0; i < 503; i++)
      insert.run(
        f.thread.id,
        "message-" + i,
        "turn",
        "assistant",
        "final",
        i === 0 ? "Давнее совпадение" : "Сообщение " + i,
        i,
        i,
        new Date(i * 1000).toISOString(),
      );
    insert.run(
      f.thread.id,
      "hidden",
      "turn",
      "assistant",
      "analysis",
      "SECRET совпадение",
      600,
      600,
      new Date().toISOString(),
    );
    insert.run(
      f.thread.id,
      "tool",
      "turn",
      "tool",
      "final",
      "SECRET совпадение",
      601,
      601,
      new Date().toISOString(),
    );
    const url =
      "/api/workspace/search?" + new URLSearchParams({ q: "СОВПАДЕНИЕ", threadId: f.thread.id });
    assert.equal((await f.app.inject({ url })).statusCode, 401);
    const first = await f.app.inject({ url, headers: f.headers });
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(first.json().nextOffset, 500);
    assert.equal(first.json().items.length, 0);
    const second = (await f.app.inject({ url: url + "&offset=500", headers: f.headers })).json();
    assert.equal(second.items.length, 1);
    assert.equal(second.items[0].target.messageId, "message-0");
    assert.doesNotMatch(JSON.stringify(second), /SECRET/);
    const global = (
      await f.app.inject({
        url: "/api/workspace/search?q=" + encodeURIComponent("Давнее") + "&offset=500",
        headers: f.headers,
      })
    ).json();
    assert.equal(global.items[0].target.messageId, "message-0");
    assert.equal(f.calls.length, 0);
  } finally {
    await f.close();
  }
});
