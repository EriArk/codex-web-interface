import assert from "node:assert/strict";
import test from "node:test";
import {
  activeConversation,
  pendingConversationBinding,
} from "../ops/gpt/conversation-binding.mjs";

const source = {
  clientId: "tab",
  leaseId: "lease",
  ownerServerInstanceId: "owner",
  conversationId: "WEB:11111111-1111-4111-8111-111111111111",
};
const activeRequest = { requestId: "request", leaseId: "lease", ownerServerInstanceId: "owner" };
const canonical = "22222222-2222-4222-8222-222222222222";
const f = () => ({
  requestId: "request",
  clientId: "tab",
  submittedUserTurnKey: "",
  state: { submission: "accepted", source },
  observation: { conversationId: canonical, activeRequest },
});
test("only the same accepted new-chat lease may wait for canonical user evidence", () => {
  assert.equal(pendingConversationBinding(f()), true);
  for (const value of ["", "pending", "submitted"]) {
    const x = f();
    x.state = { ...x.state, submission: value };
    assert.equal(pendingConversationBinding(x), false);
  }
  for (const field of ["clientId", "submittedUserTurnKey", "requestId"]) {
    const x = f();
    x[field] = "different";
    assert.equal(pendingConversationBinding(x), false);
  }
  for (const field of ["leaseId", "ownerServerInstanceId", "requestId"]) {
    const x = f();
    x.observation = { ...x.observation, activeRequest: { ...activeRequest, [field]: "different" } };
    assert.equal(pendingConversationBinding(x), false);
  }
});
test("canonical chats, unknown ids and a changed provisional candidate retain normal mismatch handling", () => {
  for (const value of ["", "new", canonical, "WEB:"]) {
    const x = f();
    x.state = { ...x.state, source: { ...source, conversationId: value } };
    assert.equal(pendingConversationBinding(x), false);
  }
  for (const value of ["", "new", "WEB:other", "https://chatgpt.com/c/" + canonical]) {
    const x = f();
    x.observation = { ...x.observation, conversationId: value };
    assert.equal(pendingConversationBinding(x), false);
  }
  const x = f();
  x.state = { ...x.state, lastObservation: { data: { pendingConversationId: canonical } } };
  assert.equal(pendingConversationBinding(x), true);
  x.state.lastObservation.data.pendingConversationId = "33333333-3333-4333-8333-333333333333";
  assert.equal(pendingConversationBinding(x), false);
});

test("Hub history fallback cannot adopt a provisional URL before submitted-user proof", () => {
  const health = {
    activeClient: { id: "tab", url: "https://chatgpt.com/c/" + canonical },
    activeRequests: [
      {
        requestId: "request",
        clientId: "tab",
        canonicalState: {
          requestId: "request",
          submission: "accepted",
          source,
          response: { userTurnKey: "" },
        },
      },
    ],
  };
  assert.deepEqual(activeConversation(health), {
    requestId: "request",
    nativeId: null,
    generating: false,
  });
  health.activeRequests[0].canonicalState = {
    requestId: "request",
    submission: "submitted",
    source: { ...source, conversationId: canonical },
    response: { userTurnKey: "user" },
  };
  assert.equal(activeConversation(health).nativeId, canonical);
  health.activeClient.url = "https://chatgpt.com/c/33333333-3333-4333-8333-333333333333";
  assert.equal(activeConversation(health).nativeId, null);
  health.activeRequests = [];
  assert.equal(activeConversation(health).requestId, null);
  assert.equal(activeConversation(health).nativeId, "33333333-3333-4333-8333-333333333333");
});
