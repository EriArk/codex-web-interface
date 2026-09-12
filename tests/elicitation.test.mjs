import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { elicitationResponse, parseElicitation } from "../apps/hub/dist/elicitation.js";
import { formRequest } from "./elicitation-fixture.mjs";
import { handoffFixture } from "./handoff-fixture.mjs";

const valid = { title: "Demo", enabled: false, count: 0, labels: ["x"] };
test("extended OpenAI forms return selected resources and images without fetching external previews", () => {
  const request = {
    mode: "openaiForm",
    serverName: "Files",
    message: "Pick",
    requestedSchema: {
      type: "object",
      required: ["files"],
      properties: {
        files: {
          type: "array",
          items: { type: "string", format: "uri" },
          "x-openai-input": {
            type: "file",
            selection: "implicit",
            options: [
              {
                uri: "file:///D:/demo.md",
                name: "Demo",
                icons: [{ src: "https://private.test/secret" }],
              },
            ],
            userOptions: { kind: "file", accept: [".md"] },
          },
        },
      },
    },
  };
  const { form } = parseElicitation(request);
  assert.equal(form.mode, "form");
  assert.equal(form.fields[0].input, "files");
  assert.deepEqual(form.fields[0].default, ["file:///D:/demo.md"]);
  assert(!JSON.stringify(form).includes("private.test"));
  assert.deepEqual(
    elicitationResponse(form, "accept", { files: ["file:///D:/other.md"] }).content.files,
    ["file:///D:/other.md"],
  );
  for (const uri of ["https://example.com/foo.md", "file:///D:/other.exe", "file:///D:/%00.md"])
    assert.throws(() => elicitationResponse(form, "accept", { files: [uri] }));
  const image = "data:image/png;base64,iVBORw0KGgo=";
  const legacy = parseElicitation({
    mode: "openai/form",
    requestedSchema: {
      type: "object",
      properties: {
        cover: { type: "openai/imagePicker", items: [{ id: "one", title: "Обложка", image }] },
      },
    },
  }).form;
  assert.equal(legacy.mode, "form");
  assert.equal(legacy.fields[0].options[0].image, image);
  assert.equal(elicitationResponse(legacy, "accept", { cover: "one" }).content.cover, "one");
  assert.throws(() => elicitationResponse(legacy, "accept", { cover: "other" }));
});
test("extended form patterns are bounded and unknown constraints remain explicit", () => {
  const parse = (pattern) =>
    parseElicitation({
      mode: "openaiForm",
      requestedSchema: { type: "object", properties: { code: { type: "string", pattern } } },
    }).form;
  const form = parse("^[a-z]+$");
  assert.equal(form.mode, "form");
  assert.equal(elicitationResponse(form, "accept", { code: "abc" }).content.code, "abc");
  assert.throws(() => elicitationResponse(form, "accept", { code: "123" }));
  for (const p of ["(a+)+$", "a*a*a*", "(?=bad)", ".*suffix"])
    assert.equal(parse(p).mode, "unsupported");
  const unknown = parseElicitation({
    mode: "openaiForm",
    requestedSchema: {
      type: "object",
      properties: { x: { type: "string", "x-openai-input": { type: "secret-widget" } } },
    },
  }).form;
  assert.equal(unknown.mode, "unsupported");
});
test("typed elicitation preserves values and validates standard schema constraints", () => {
  const { form } = parseElicitation(formRequest);
  assert.equal(form.mode, "form");
  assert.equal(form.fields.find((f) => f.key === "enabled").default, false);
  assert.deepEqual(elicitationResponse(form, "accept", valid), {
    action: "accept",
    content: valid,
  });
  for (const patch of [
    { title: "x" },
    { title: "123456789" },
    { enabled: "false" },
    { count: -1 },
    { count: 1.5 },
    { count: 5 },
    { ratio: 2 },
    { labels: [] },
    { labels: ["x", "x"] },
    { labels: ["other"] },
    { day: "2026-02-30" },
    { when: "yesterday" },
    { email: "invalid" },
    { link: "bad uri" },
    { style: "c" },
    { extra: 1 },
  ])
    assert.throws(
      () => elicitationResponse(form, "accept", { ...valid, ...patch }),
      /Проверь|неизвестное/,
    );
  assert.throws(() => elicitationResponse(form, "accept", {}));
  assert.deepEqual(elicitationResponse(form, "decline", valid), {
    action: "decline",
    content: null,
  });
  assert.deepEqual(elicitationResponse(form, "cancel"), { action: "cancel", content: null });
});
test("elicitation handles legacy/untitled enums and refuses unsupported schemas or unsafe URLs", () => {
  const parsed = parseElicitation({
    ...formRequest,
    requestedSchema: {
      type: "object",
      properties: {
        one: { type: "string", enum: ["a", "b"], enumNames: ["A", "B"] },
        many: { type: "array", items: { type: "string", enum: ["a", "b"] } },
      },
    },
  });
  assert.equal(parsed.form.fields[0].options[1].title, "B");
  assert.deepEqual(
    elicitationResponse(parsed.form, "accept", { one: "a", many: ["a", "b"] }).content.many,
    ["a", "b"],
  );
  for (const requestedSchema of [
    { type: "object", properties: { nested: { type: "object" } } },
    { type: "object", properties: { code: { type: "string", pattern: "[a-z]" } } },
    { type: "array" },
  ]) {
    const { form } = parseElicitation({ ...formRequest, requestedSchema });
    assert.equal(form.mode, "unsupported");
    assert.throws(() => elicitationResponse(form, "accept", {}));
    assert.equal(elicitationResponse(form, "cancel").action, "cancel");
  }
  for (const url of [
    "javascript:alert(1)",
    "data:text/html,test",
    "file:///etc/passwd",
    "https://user:password@example.com/",
  ])
    assert.equal(parseElicitation({ ...formRequest, mode: "url", url }).form.mode, "unsupported");
  const parsedUrl = parseElicitation({
    ...formRequest,
    mode: "url",
    url: "https://example.com/auth?secret=private-value",
  });
  assert.equal(parsedUrl.form.host, "example.com");
  assert(!JSON.stringify(parsedUrl.form).includes("private-value"));
});
test("MCP request survives client reload, validates before consuming receipt, responds once and expires", async () => {
  const f = await handoffFixture();
  try {
    await f.release();
    await f.sessions.resume(f.thread.id);
    const r = await f.sessions.runtime("project"),
      replies = [];
    r.rpc.respond = (id, result) => replies.push({ id, result });
    r.rpc.rejectRequest = () => assert.fail("supported request rejected");
    const request = {
      id: 71,
      method: "mcpServer/elicitation/request",
      params: { ...formRequest, threadId: f.thread.codexThreadId, turnId: "turn" },
    };
    await f.sessions.request(r, request);
    await f.sessions.request(r, request);
    const pending = f.sessions.pending(f.thread.id);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].elicitation.mode, "form");
    const url = `/api/approvals/${pending[0].id}/elicitation`,
      key = randomUUID();
    const post = (payload, customKey = key) =>
      f.app.inject({
        method: "POST",
        url,
        headers: { ...f.headers, "idempotency-key": customKey },
        payload,
      });
    assert.equal(
      (await f.app.inject({ method: "POST", url, payload: { action: "cancel" } })).statusCode,
      401,
    );
    const invalid = await post({ action: "accept", content: {} });
    assert.equal(invalid.statusCode, 400);
    assert.equal(f.sessions.pending(f.thread.id).length, 1);
    assert.equal(replies.length, 0);
    const response = await post({ action: "accept", content: valid });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal((await post({ action: "accept", content: valid })).statusCode, 200);
    assert.equal(replies.length, 1);
    assert.deepEqual(replies[0].result.content, valid);
    assert.equal((await post({ action: "cancel" }, randomUUID())).statusCode, 409);
    assert.equal(f.sessions.pending(f.thread.id).length, 0);
    assert(
      !JSON.stringify(f.store.db.prepare("SELECT payload FROM events").all()).includes('"Demo"'),
    );
    await f.sessions.request(r, {
      ...request,
      id: 72,
      params: {
        ...request.params,
        mode: "url",
        url: "https://example.com/auth?secret=private-value",
        elicitationId: "external",
      },
    });
    const [link] = f.sessions.pending(f.thread.id);
    assert(!JSON.stringify(link).includes("private-value"));
    assert(
      !JSON.stringify(f.store.db.prepare("SELECT payload FROM events").all()).includes(
        "private-value",
      ),
    );
    const opened = await f.app.inject({
      url: `/api/approvals/${link.id}/open`,
      headers: f.headers,
    });
    assert.equal(opened.statusCode, 302);
    assert.equal(opened.headers.location, "https://example.com/auth?secret=private-value");
    r.rpc.emit("notification", "serverRequest/resolved", {
      threadId: f.thread.codexThreadId,
      requestId: 72,
    });
    assert.equal(f.sessions.pending(f.thread.id).length, 0);
    assert.equal(
      (await f.app.inject({ url: `/api/approvals/${link.id}/open`, headers: f.headers }))
        .statusCode,
      409,
    );
    await f.sessions.request(r, { ...request, id: 73 });
    const [expired] = f.sessions.pending(f.thread.id),
      events = [];
    f.sessions.on("event", (event) => events.push(event));
    r.rpc.emit("fault", { code: "CODEX_DISCONNECTED" });
    assert.equal(f.sessions.pending(f.thread.id).length, 0);
    assert.equal(f.store.thread(f.thread.id).status, "unknown");
    assert(
      events.some((event) => event.type === "approval.resolved" && event.payload.id === expired.id),
    );
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: `/api/approvals/${expired.id}/elicitation`,
          headers: { ...f.headers, "idempotency-key": randomUUID() },
          payload: { action: "cancel" },
        })
      ).statusCode,
      409,
    );
  } finally {
    await f.close();
  }
});
test("schema constraints are not silently discarded", () => {
  for (const schema of [
    { type: "object", properties: {}, additionalProperties: true },
    { type: "object", properties: { a: { type: "string", minLength: 4, maxLength: 2 } } },
    {
      type: "object",
      properties: { a: { type: "array", items: { type: "string", enum: ["a"], pattern: "x" } } },
    },
    {
      type: "object",
      properties: { a: { type: "string", oneOf: [{ const: "a", title: "A", pattern: "x" }] } },
    },
  ])
    assert.equal(
      parseElicitation({ ...formRequest, requestedSchema: schema }).form.mode,
      "unsupported",
    );
  const { form } = parseElicitation({
    ...formRequest,
    requestedSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      required: ["a"],
      properties: { a: { type: "array", items: { type: "string", enum: ["a"] } } },
    },
  });
  assert.equal(form.mode, "form");
  assert.deepEqual(elicitationResponse(form, "accept", { a: [] }).content, { a: [] });
});
