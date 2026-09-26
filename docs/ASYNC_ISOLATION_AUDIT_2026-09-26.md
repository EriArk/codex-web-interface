# Async isolation audit — 2026-09-26

## Why this audit exists

A GPT failure exposed a broader architectural question:

> Can one slow, failed, or unknown mutation make unrelated reads, navigation, or another scope stop working?

The triggering symptom is severe: if a GPT message is only partially submitted or its delivery becomes uncertain, the entire GPT chat can stop loading or refreshing until the broken operation is repaired.

This audit checks the same failure class across the current project. It is not a generic performance review. The focus is specifically **lock scope, queue scope, read/write coupling, and unknown-operation isolation**.

## Desired rule

A failed mutation should normally degrade only the smallest unsafe scope.

Examples:

- a send with unknown delivery may block another send to that conversation;
- a GitHub mutation with an unknown receipt may block another conflicting mutation on that repository or branch;
- a file replacement with an uncertain result may block another write to that file or destination.

It should **not** normally block reading already available history, opening another chat, reading catalog/navigation, inspecting Results, unrelated Projects/repositories, or unrelated users.

Global blocking is appropriate only when the underlying provider truly has a global safety constraint, or during explicit maintenance/recovery.

# Findings

## 1. Native GPT read/write coupling — HIGH

There are two independent layers that both serialize native GPT traffic too broadly.

### Layer A — Hub native client queue

File: apps/hub/src/gpt-native.ts

NativeGptReadClient.call() puts reads and mutations into one queue. drain() executes one entry at a time:

~~~ts
while (this.queue.length) {
  ...
  const entry = this.queue.splice(index, 1)[0]!;
  await entry.run();
}
~~~

Interactive work may move ahead of queued reads, but there is still only one active request.

Therefore a slow dispatchText, recovery, upload, or other mutation can hold later history/catalog/model reads behind it.

### Layer B — native service global busy flag

File: ops/gpt-native/service.mjs

Except for status and the special readLive path, every operation shares one this.busy flag:

~~~js
if (this.busy) fail('BUSY');

this.busy = true;
try {
  ...
} finally {
  this.busy = false;
}
~~~

This includes both mutations and ordinary reads such as readConversationGraph, readModels, readCatalog, readPins, readProjects, readProject, and readProjectConversations.

So even if the Hub queue were changed, the native service would still reject or serialize normal reads behind a writer.

### Existing evidence that the split is needed

readLive already bypasses the global writer/history lane deliberately:

~~~js
// A read of already received text must not queue behind a writer/history read.
if (input.operation === 'readLive') { ... }
~~~

The same design principle should apply to safe canonical/history/navigation reads.

### Secondary coupling: health/readiness

File: apps/hub/src/gpt-native-provider.ts

connection() does not only read supervisor status. Periodically it also calls models() to verify usability.

Because readModels currently uses the same global native busy path, an unrelated in-flight or failed mutation can make connection verification fail and make the UI look like GPT itself is unhealthy, even when read-only state should still be usable.

### Secondary coupling: account-wide unfinished-send guard

File: apps/hub/src/gpt.ts

hasUnfinishedJobs() checks every queued, preparing, running, or unknown GPT job in the account.

That predicate is reused to block unrelated GPT mutation families such as native operations, project-content operations and workspace operations.

This is conservative, but broader than the minimum safe scope. An unknown send in Chat A can prevent unrelated mutation work in Chat B or another GPT project even when there is no demonstrated provider conflict.

### What is already good

The web/history layer is mostly prepared for proper isolation:

- useGptHistory() has independent state and polling;
- history keeps cached content on transient failure;
- GptHistoryCache.readable() can return stale history for transient read errors;
- history deltas preserve DOM/scroll/drafts;
- send enqueueing does not fundamentally require rendering history first.

The main coupling is below that layer.

### Required direction

Split native GPT work conceptually into:

1. **read lane**
   - bounded concurrency;
   - dedupe identical reads;
   - current account rate-limit gate;
   - safe during pending/unknown sends where provider semantics allow it.

2. **mutation lane**
   - serialized conservatively;
   - durable receipts;
   - no blind replay;
   - scope blocking to the smallest proven unsafe identity.

3. **live lane**
   - lightweight progress/status;
   - must not queue behind a slow mutation.

Do not parallelize mutations merely for performance. The first goal is read availability.

## 2. GPT account-wide mutation blocking — MEDIUM/HIGH

File: apps/hub/src/gpt.ts

Several operation families use !hasUnfinishedJobs() as a global admission condition.

This means one unfinished send can block native edit/regenerate-style operations, project-content mutations, workspace/schedule/Canvas-style mutations, and some library actions.

This does not directly explain history failure, but it is the same oversized-scope pattern.

### Recommendation

After read/write decoupling, classify mutation conflicts by actual scope:

- same conversation;
- same GPT project;
- account-global provider operation;
- truly global manual recovery.

Keep account-global serialization only where the native provider contract requires it.

## 3. Team GitHub write serialization is broader than necessary — MEDIUM

File: apps/hub/src/team-github.ts

Team GitHub operations use a serial key equivalent to:

~~~text
write:<actor>
~~~

for prepare/status/apply paths.

That serializes GitHub writes per user, even across unrelated Projects/repositories.

This is much safer than the GPT problem because read paths are not globally blocked, but a slow GitHub operation in Project A can delay a status/write operation in Project B for the same user.

The database safety check itself is already scoped more narrowly to projectId + userId.

### Recommendation

Consider a serial key based on the actual conflicting authority, for example actor + repository/project, while retaining per-operation receipts and exact identity checks.

Do not change this until tests prove the machine-side gh helper can safely service independent repositories concurrently.

## 4. Issue Drawer has one global pending operation — MEDIUM

File: apps/hub/src/issue-drawer.ts

IssueDrawer has one service-wide pending Promise and serial() rejects any new serialized drawer operation while it exists.

A long source capture/preparation/publication can therefore block unrelated drawer mutations. edit/remove/reorder also explicitly reject while pending exists.

Read-only list() and item() remain available, so this does **not** create a full-app outage.

### Recommendation

Split locking by operation scope:

- capture/source item;
- package/batch publication;
- item edit/reorder.

A running publication should not necessarily prevent editing an unrelated draft that is not part of that batch.

Preserve batch immutability once it has been reviewed/frozen.

# Systems that already use healthier scoping

These are useful patterns to preserve rather than rewrite.

## Local Files

File: apps/hub/src/file-tools.ts

Read/open does not grant mutation authority. Manual writes use an explicit checkout-bound capability and machine-local receipts. There is no single service-wide lock that makes file browsing unavailable because one write is uncertain.

## Direct GitHub Files

File: apps/hub/src/repository-files.ts

The mutation serializer is scoped by Project. The repository file read endpoint does not go through that mutation serializer.

An unknown write blocks another conflicting write in that Project but not basic reading. This is close to the desired GPT behavior.

## Project Delivery

File: apps/hub/src/project-delivery.ts

Running/unknown machine operations block conflicting delivery mutations, while status is specifically allowed to inspect the exact previous receipt. Recovery does not re-dispatch. The locking boundary is machine/project oriented rather than application-global.

## Project Preparation

File: apps/hub/src/project-preparation.ts

Pending work is stored in a map keyed by Project. One Project preparation does not create a global application lock.

## Codex queue

File: apps/hub/src/queue.ts

Mutation locking is per thread. Queue reads are separate. Unknown transfer state is attached to the affected thread/transfer.

## Codex project/session mutations

File: apps/hub/src/sessions.ts

The main mutation lock is per Project. It is intentionally used for native state-changing operations; ordinary stored history/navigation is not globally blocked by it.

## Codex schedules

File: apps/hub/src/codex-schedules.ts

The scheduler has one internal work pass, but waiting/conflict suppression is tracked per schedule target. User-facing schedule reads do not depend on the scheduler mutation being idle.

## Communication / Brainstorm

Files: apps/hub/src/communication.ts and apps/hub/src/brainstorm.ts

These mostly rely on scoped SQLite transactions/revisions rather than a broad in-memory busy flag that blocks reads.

## Maintenance

File: apps/hub/src/team-hub.ts

Maintenance/deployment intentionally uses broad admission blockers. This is a legitimate global lock because replacing runtime state while mutations are active is the operation being protected. It should not be used as a model for normal UI interaction.

# Priority

## P0 / user-visible correctness

**Native GPT read/write separation.**

The observed symptom can make an entire core workspace unusable because one send entered a bad state.

## P1

Reduce GPT account-global mutation guards after the read path is safe.

## P2

Review narrower mutation keys for Team GitHub and Issue Drawer.

These are currently usability/latency issues, not whole-workspace outages.

# Acceptance tests for the GPT fix

## Hung dispatch must not freeze reads

1. Open Chat A with loaded history.
2. Start a send.
3. Hold native dispatchText for at least 20 seconds.
4. While it is still in flight:
   - refresh Chat A history;
   - open Chat B;
   - load catalog;
   - load Projects;
   - read model metadata;
   - open already-known Results.
5. All reads must remain available or serve an explicitly stale cached view.
6. Only unsafe mutations should be blocked.

## Unknown send must remain local to mutation state

1. Let the dispatch cross its durable send boundary.
2. Drop the acknowledgement so the send becomes unknown.
3. Verify:
   - Chat A history still loads;
   - Chat B loads;
   - catalog/navigation loads;
   - Results remain readable;
   - the affected send shows unknown / check delivery;
   - no send is replayed automatically.

## Read failure must not poison mutation state

1. Start from an idle chat.
2. Fail canonical history reads temporarily.
3. Cached history remains visible.
4. The read error does not create/change a mutation receipt.
5. When the read path recovers, history refreshes without resubmitting anything.

## Health must distinguish read and write capability

During a blocked/unknown mutation:

- account/runtime can still report readable if safe reads work;
- canSend may be false;
- the UI must not collapse both into one GPT unavailable state.

## Manual recovery

Manual recovery may block mutations globally if required, but should keep safe cached/read-only surfaces available whenever the provider can serve them.

# Non-goals

- Do not weaken exact account/conversation/project binding.
- Do not remove durable receipts.
- Do not replay unknown sends.
- Do not bypass account-wide 429 cooldown.
- Do not parallelize multiple native writes without evidence that the provider supports it.
- Do not allow stale cached history to prove a mutation succeeded.

The desired change is **failure isolation**, not optimistic concurrency.
