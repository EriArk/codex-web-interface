# GPT incremental history and Results — 2026-09-23

This stage reduces repeated work between the Hub and browser. It does not replace the native canonical conversation read with an undocumented upstream delta API.

## Behavior

- Public messages have per-message fingerprints and cumulative prefix versions. Unchanged messages retain object identity. An unchanged poll reuses the history array and avoids rewriting the full private disk snapshot; freshness is persisted at least hourly during continuing reads.
- A bounded journal of 16 versions allows the browser to request a changed suffix of at most 20 messages. The delta binds the exact base revision and replacement/predecessor identity. Older loaded messages, scroll state and draft remain intact. Unknown versions, large missed bursts and unmatched anchors fall back to a canonical page. Native branch changes never concatenate unrelated tails.
- Each retained conversation owns a Results projection. Only changed messages repeat Markdown/artifact/demo extraction. Public reasoning groups, duplicate link precedence, file identities and category counts match the canonical projection. Projection memory is charged to the existing shared history budget; no separate unbounded cache or binary prefetch is added.
- Results first-page refresh negotiates a revision, unchanged response or bounded upsert/removal delta. Loaded older pages and unchanged cards remain mounted. Missed additions extending beyond the current first page, edits in older turns, expired journals and unknown versions return a replacement page to avoid gaps. Several individually small missed updates are checked together.
- Exact result navigation and cached metadata still require current authorization and library visibility. Authorizations are rechecked after asynchronous reads. Account-local browser caches retain their existing bounds and logout invalidation.

## Verification

Linux typechecks, production web build and changed-file Biome pass. The focused suite has 38 passing checks across incremental history, continuity, cache/session retention, public progress, links and text/result artifacts.

`tests/gpt-incremental.test.mjs` exercises a 1,000-message history, same-length edits, deletion, branch replacement, invalid/expired revisions, snapshot restart, hourly disk refresh, full/indexed Results parity, missed bursts and actual Hub routes with separate account stores and revoked access. Adding two messages sends two messages instead of twenty. A 50-demo fixture is extracted 50 times initially, zero additional times for an unchanged snapshot, and once for one changed message.

`tests/gpt-incremental.browser.mjs` runs the actual hook and ResultFeed in Chromium and WebKit against real cache/index contracts. It verifies loaded older pages, unchanged DOM nodes, scroll and draft continuity, image DOM/request stability, branch replacement and read-only refresh. Existing history recovery and Results links/demo browser suites pass in both engines; the latter covers four themes. Physical iPhone/iPad acceptance remains deferred to owner use.

## Delivery and remaining scope

Hub/web/shared contracts change together. Windows helpers and the native connector contract do not change in this stage; there is no helper replacement or native process restart. Release installation uses the ordinary idle guard and is tracked separately from source completion.

Native graph fetching and public normalization still examine the canonical graph. The projection/delta journal is memory-resident; existing private disk snapshots restore history after restart, while a missing projection is rebuilt once. A durable incremental native ingestion/projection store and complete closure of #188 are not claimed here.

Next owner-selected stage: Brainstorm, after explicit continuation; recommended reasoning **Очень высокое (`xhigh`)** for room lifecycle, shared materials, permissions and transition into a project. Additional access downgrade/removal work remains deferred.
