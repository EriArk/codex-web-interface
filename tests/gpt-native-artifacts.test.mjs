import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import test from "node:test";
import { nativeArtifacts } from "../ops/gpt-native/renderer-artifacts.mjs";
import { nativeRead } from "../ops/gpt-native/renderer-read.mjs";

const conversationId = "10000000-0000-4000-8000-000000000001";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const artifactId = (messageId, path) =>
  `sandbox-${hash(JSON.stringify([conversationId, messageId, path]))}`;

function fixture() {
  const account = { accountId: "account-a", userId: "user-a", authenticatedUserId: "user-a" };
  const binding = {
    conversationId,
    accountFingerprint: hash(JSON.stringify(Object.values(account))),
  };
  const conversation = { conversation_id: conversationId, current_node: "node", mapping: {} };
  const state = {
    url: "https://chatgpt.com/backend-api/estuary/content?private=secret",
    response: () => new Response("result bytes"),
    onResolve: () => {},
    onFetch: () => {},
    calls: [],
  };
  const download = async (transport, url, options) => {
    state.calls.push({ transport, url, options });
    state.onFetch();
    return state.response();
  };
  const service = {
    M9: {
      accessInputs: { readAccountInfo: async () => ({ status: "ready", data: { ...account } }) },
    },
    kWt: {
      safeGet: async (route, options) => {
        state.calls.push({ route, options });
        if (route === "/conversation/{conversation_id}") return conversation;
        assert.equal(route, "/conversation/{conversation_id}/interpreter/download");
        state.onResolve();
        return {
          status: "success",
          download_url: state.url,
          metadata: { secret: "private metadata" },
        };
      },
    },
    $rn: { getInstance: () => ({ fetch: (url, options) => download("native", url, options) }) },
  };
  const runtime = {
    crypto: webcrypto,
    btoa,
    electronBridge: { getSentryInitOptions: () => ({ appVersion: "26.915.31945" }) },
    fetch: (url, options) => download("cdn", url, options),
  };
  const node = (id, text, extra = {}, parent = null) => {
    conversation.mapping[id] = {
      id,
      parent,
      message: {
        id,
        author: { role: "assistant" },
        content: { content_type: "text", parts: [text] },
        ...extra,
      },
    };
    conversation.current_node = id;
  };
  node("node", "[Download](sandbox:/mnt/data/result.txt)");
  const run = (request) =>
    nativeArtifacts({ ...binding, ...request }, nativeRead, async () => service, runtime);
  const list = () => run({ operation: "listArtifacts" });
  const read = (extra = {}) =>
    run({
      operation: "readArtifact",
      messageId: "node",
      artifactId: artifactId("node", "/mnt/data/result.txt"),
      ...extra,
    });
  return { state, account, binding, conversation, node, list, read, run };
}

test("artifact discovery uses public current-branch links, stable message/path IDs and no code examples", async () => {
  const f = fixture();
  f.node(
    "node",
    [
      "[one](sandbox:/mnt/data/result.txt)",
      "[duplicate](sandbox:/mnt/data/result.txt)",
      "![image](<sandbox:/mnt/data/a%20b.png>)",
      "`[inline](sandbox:/mnt/data/code.txt)`",
      "```md",
      "[fenced](sandbox:/mnt/data/fence.txt)",
      "```",
      "[bad](sandbox:/mnt/data/../secret.txt)",
      "[bad](sandbox:/mnt/data/%2e%2e/secret.txt)",
      "[bad](sandbox:/mnt/data/%252e%252e/secret.txt)",
      "[bad](sandbox:/etc/private.txt)",
    ].join("\n"),
  );
  f.node("hidden", "[private](sandbox:/mnt/data/hidden.txt)", { channel: "analysis" }, "node");
  f.node("user", "[upload](sandbox:/mnt/data/user.txt)", { author: { role: "user" } }, "hidden");
  f.node("offbranch", "[wrong](sandbox:/mnt/data/other.txt)", {}, "user");
  f.conversation.current_node = "user";
  const result = await f.list();
  assert.deepEqual(
    result.artifacts.map((a) => a.name),
    ["result.txt", "a b.png"],
  );
  assert.equal(result.artifacts[0].id, artifactId("node", "/mnt/data/result.txt"));
  assert.equal(result.artifacts[1].mime, "image/png");
  assert.equal(result.artifacts[1].image, true);
  assert.equal(result.otherMediaResolved, false);
  assert.equal(f.state.calls.length, 1);
});

test("download resolves the exact canonical message/path through native principal-bound binary transport", async () => {
  const f = fixture(),
    result = await f.read();
  assert.equal(Buffer.from(result.base64, "base64").toString(), "result bytes");
  assert.equal(result.bytes, 12);
  assert.equal(result.sha256, hash("result bytes"));
  const resolved = f.state.calls.find((c) => c.route?.endsWith("/download"));
  assert.deepEqual(resolved.options.parameters, {
    path: { conversation_id: conversationId },
    query: { message_id: "node", sandbox_path: "/mnt/data/result.txt" },
  });
  const fetch = f.state.calls.find((c) => c.transport);
  assert.equal(fetch.transport, "native");
  for (const call of [resolved, fetch])
    assert.deepEqual(call.options.expectedIdentity, { accountId: "account-a", userId: "user-a" });
  assert.deepEqual(fetch.options.headers, { "X-OpenAI-Attach-Auth": "1" });
  assert.doesNotMatch(JSON.stringify(result), /private|secret|download_url|account-a/);
});

test("artifact IDs cannot be substituted across messages, paths or non-current branches", async () => {
  const f = fixture();
  f.node("second", "[same name](sandbox:/mnt/data/result.txt)", {}, "node");
  await assert.rejects(f.read({ messageId: "second" }), /ARTIFACT_NOT_ON_BRANCH/);
  await assert.rejects(
    f.read({ artifactId: artifactId("node", "/mnt/data/other.txt") }),
    /ARTIFACT_NOT_ON_BRANCH/,
  );
  f.conversation.current_node = "node";
  await assert.rejects(
    f.read({ messageId: "second", artifactId: artifactId("second", "/mnt/data/result.txt") }),
    /MESSAGE_NOT_ON_BRANCH/,
  );
  await assert.rejects(f.read({ artifactId: "https://evil.example" }), /INVALID_REQUEST/);
  assert.equal(
    f.state.calls.some((c) => c.route?.endsWith("/download") || c.transport),
    false,
  );
});

test("CDN downloads omit credentials and reject redirects; other URL shapes never fetch", async () => {
  const f = fixture();
  f.state.url = "https://files.oaiusercontent.com/result?private=secret";
  await f.read();
  const fetch = f.state.calls.find((c) => c.transport);
  assert.equal(fetch.transport, "cdn");
  assert.equal(fetch.options.credentials, "omit");
  assert.equal(fetch.options.redirect, "error");
  assert.equal(fetch.options.referrerPolicy, "no-referrer");
  for (const url of [
    "http://files.oaiusercontent.com/a",
    "https://evil.example/a",
    "https://chatgpt.com/backend-api/other",
    "https://files.oaiusercontent.com.evil.example/a",
    "https://user:pass@files.oaiusercontent.com/a",
    "https://files.oaiusercontent.com:8443/a",
    "https://files.oaiusercontent.com/a#fragment",
  ]) {
    f.state.url = url;
    f.state.calls.length = 0;
    await assert.rejects(f.read(), /UNSAFE_ASSET_URL/);
    assert.equal(
      f.state.calls.some((c) => c.transport),
      false,
    );
  }
});

test("account changes during resolution or binary retrieval discard all bytes", async () => {
  for (const phase of ["onResolve", "onFetch"]) {
    const f = fixture();
    f.state[phase] = () => {
      f.account.userId = "other";
    };
    await assert.rejects(f.read(), /ACCOUNT_CHANGED/);
    if (phase === "onResolve")
      assert.equal(
        f.state.calls.some((c) => c.transport),
        false,
      );
  }
});

test("declared and streamed limits cancel the reader without returning partial data", async () => {
  for (const declared of [false, true]) {
    const f = fixture();
    let cancelled = false;
    f.state.response = () => ({
      ok: true,
      headers: new Headers(declared ? { "content-length": "1048577" } : {}),
      body: {
        getReader: () => ({
          read: async () => ({ done: false, value: new Uint8Array(1048577) }),
          cancel: async () => {
            cancelled = true;
          },
        }),
      },
    });
    await assert.rejects(f.read(), /ASSET_TOO_LARGE/);
    assert.equal(cancelled, true);
  }
});

test("unavailable, empty and failed downloads expose fixed errors without upstream URL details", async () => {
  const f = fixture();
  f.state.response = () => new Response(null, { status: 404 });
  await assert.rejects(f.read(), /^Error: NATIVE_ASSET_UNAVAILABLE$/);
  f.state.response = () => new Response("");
  await assert.rejects(f.read(), /^Error: NATIVE_ASSET_EMPTY$/);
  f.state.response = () => {
    throw Error("private URL and secret token");
  };
  await assert.rejects(f.read(), /^Error: NATIVE_ASSET_UNAVAILABLE$/);
});

test("artifact flood fails before any resolver or binary request", async () => {
  const f = fixture();
  f.node(
    "node",
    Array.from({ length: 33 }, (_, i) => `[${i}](sandbox:/mnt/data/${i}.txt)`).join("\n"),
  );
  await assert.rejects(f.list(), /TOO_MANY_ARTIFACTS/);
  assert.equal(f.state.calls.length, 1);
});
