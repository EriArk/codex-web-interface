# Collaboration Activity — first slice

Open a selected Space and choose **Активность**. The separate themed window
preserves the mounted workspace. Project and GitHub-author filters are local;
20 groups appear initially, with more on demand. Consecutive commits by the same
verified GitHub author in one project, on one UTC day and within 30 minutes are
grouped; expanding keeps every exact SHA/link. PRs and Issues remain separate.

This slice indexes default-branch commits and recently updated Issues/PRs. It
shows the original object's author and current observed status, **not** an
assertion that the author performed its latest transition. It does not reconstruct
an exhaustive GitHub event history. A missing linked GitHub author is displayed
as the original Git author name and never guessed to be a Hub member.

Reads reuse the fixed GitHub worker over each viewer's own authorized checkout.
No fallback to a project owner's credentials. Space membership, project grant,
checkout binding and execution epoch are checked around each read. GitHub access
is rechecked even for a recent cached page and on source open. Repository numeric
identity prevents reusing sources after same-name repository replacement. The
external GitHub page performs its own object-level authorization; it may show 404
for a deleted object. There is no new internal commit/PR viewer in this slice.

The Team database contains a private index per viewer/Space/Project, capped at
200 references. Each read fetches at most 30 default-branch commits, 30 recent
issue-list entries and 30 PRs; PR entries in the issue list are discarded. Reads
are coalesced, data refresh has a 60-second minimum interval, unused indexes
expire after seven days, and UI filters never call the machine. Closing the
window stops further scheduled project reads. There is no periodic poller and no
preloading of native chats, binaries, diffs or discussion bodies. Opening an
empty repository is supported. New repositories without a personal checkout
offer the existing connection flow.

Routine activity creates no notifications, writes no reports and sends no
GitHub mutations. Reactions/replies, attention routing and exact evidence handoff
to personal Project GPT remain the subsequent approved stages of #218/#200.

## Verification (2026-09-23)

- 19 focused tests: GitHub worker normalization and read-only behavior, private
  checkout routing, concurrent-read coalescing, durable index recovery, exact
  source identity, revoked membership/access and same-name repository replacement;
  existing Collaboration Spaces and GitHub mutation receipt regressions.
- Chromium and WebKit: grouping, filters without native reads, paging, source
  opening with access recheck, four themes at 390×500, 1024×768 and 1366×1024.
  Screenshots inspected; this is browser simulation, not physical iPad acceptance.
- Real read-only Windows GitHub worker against `EriArk/codex-web-interface`:
  30 commits, 28 Issues, 30 PRs, correctly bound canonical URLs. No external writes.
- Linux TypeScript and production builds. Release image and deployment evidence
  are recorded separately by the ordinary guarded updater.
