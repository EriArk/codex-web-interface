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
primary action opens an internal GitHub window above the mounted feed. Issue/PR
details reuse the existing GitHub record renderer, comments, reviews and checks.
Commits show the exact SHA, message and bounded file patches with copy controls.
The source is read again through the viewer's own worker; deleted/unavailable
objects cannot be opened from a stale index. No external tab opens by default.

The browser keeps eight account-local Activity views for 30 minutes, capped at
2 MiB in session storage. Reopening restores cards, filters, expanded commit
groups, selection and scroll position immediately. Refresh merges exact source
IDs without clearing the feed. A bounded per-source version map lets the Hub
send only new/changed cards and the current key set; repository replacement
forces a full replacement. The worker still performs bounded canonical GitHub
reads, with the existing 60-second refresh floor. This is not a GitHub webhook
or an exhaustive incremental event stream. Denied access discards the affected
cached project, and Space revision/checkout changes select a fresh cache scope.

Continuity/internal-viewer verification: 12 focused worker/Activity tests cover
the structured commit response and exact-source authorization. Chromium and
WebKit cover a held refresh response without blanking cards, unchanged/changed
delta payloads, close/reopen with filter and scroll restoration, cache removal
after denied access, internal commit/PR detail without a popup, and four-theme
phone/keyboard/tablet geometry. Existing social/GPT handoff browser scenarios
remain in the same run.

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
GitHub mutations. Local reactions, replies and addressed notifications are described below.

## Local discussion and attention

Each exact source has one local Space discussion, keyed by Space, Project,
numeric repository identity and commit SHA / Issue / PR number. Grouped commits
offer a source selector; changing grouping or filters cannot move replies.
Four optional reactions express interest, reading, thanks or a question. They
are not GitHub reviews or workflow approvals and create no notifications.

Replies are limited to 2,000 characters, with pages of 20. Answer a particular
reply or choose an explicit recipient from the current project participants.
Only that recipient receives an Activity entry in the existing Notifications
window. Unaddressed replies remain quiet. No guessed GitHub-to-Hub identity,
automatic subscription or native GitHub comment is created.

The cheap Space catalog includes generic addressed-notification metadata only.
Reading content, reacting, replying and opening an exact notification recheck
the viewer's own checkout and current native GitHub access. Stored topics remain
openable after the bounded source index expires, under the same checks. A
recreated repository cannot inherit discussions. Only displayed reply IDs are
acknowledged. Drafts and unacknowledged operation keys survive window closure
in account-local storage; transactional receipts prevent duplicate replies.
Replies refresh on opening, explicit refresh and after sending; there is no
background GitHub poll for closed discussions.

Verification: 20 focused Activity, Spaces and GitHub-worker tests pass, including
exact-source isolation, silent reactions, addressed notifications, pagination,
lost acknowledgements, revoked access and repository replacement. Chromium and
WebKit exercise two separate authenticated participants, reply routing from the
bell, private draft restoration and a dropped reply acknowledgement followed by
close/reopen/retry with one stored reply. Four themes are checked at phone and
tablet widths, including a 390×500 keyboard-constrained viewport. This is browser
simulation; no messages were sent to the owner's real collaborators as tests.

## Installed Windows helper acceptance

The initial live release left the installed Windows GitHub probe at its
September 13 version. It rejected `activity` / `evidence`, although tests of the
new compiled module passed. On September 23 the helper was backed up and updated
while the delivery task was idle; SHA-256 matched the installed Hub release.
Actual Hub -> SSH -> installed Scheduled Task reads succeeded for AltarAppsReborn
(30 commits / 28 Issues / 30 PRs) and World (12 commits / 2 Issues), including
evidence reads. Counts are a point-in-time acceptance sample, not product limits.
Future protocol changes must verify the installed helper, not a temporary copy.

The internal viewer update also replaces the installed helper while idle. Its
structured commit response preserves complete bounded file entries independently
of the GPT excerpt size; SHA-256 is
`3f81d3bd6b8522b17fbab8de601510bf9794a03d69d721b2306c35b30fa762fd`.
Actual Hub -> SSH -> Scheduled Task commit reads passed for both projects. The
prior helper is backed up; tasks, private receipts and native work are preserved.

## Discuss in Project GPT

Each card offers **Обсудить в GPT**, including a complete commit group. This
prepares a private evidence snapshot and opens the viewer's existing Project GPT
for their own checkout. Opening never sends a message. The normal composer shows
a removable context chip and preserves its previous draft. The user can ask a
question or press Send for the default request to explain the changes and risks.
No model/effort is selected on the user's behalf.

The snapshot retains up to 30 exact references. At most five sources are read in
detail: commit message/parents/stats and patches, Issue description/status, or PR
description/head/base and file patches. Each source reads at most 20 files with
bounded patches; PR head/base are checked again after the files read. Total
snapshot JSON stays within 14,000 UTF-8 bytes, leaving room under the existing
native 32 KiB input ceiling. Missing patches, extra sources and truncation are
explicitly marked. This is source evidence, not a claim of reading the entire
repository, running tests, or giving GPT new live repository tools.

Prepared snapshots are private to their viewer (100 per user, seven-day retention).
Each opening/send checks current membership, project/checkout, execution epoch,
GitHub account, repository identity and access. Sending also requires the original
Project GPT binding revision and chat. A changed binding leaves the draft intact.
Repository text is labelled untrusted source data, not instructions. The snapshot
enters the existing collapsed project-context envelope in the actual native message.

One handoff can allocate only one durable send key. The existing GPT outbox freezes
the exact input and prevents replay after uncertain delivery. Closing/reopening the
same event retains the pending context and receipt; accepted sends clear the chip.
Revisiting an already accepted event may explicitly start a new discussion.
No GitHub comments, Issues, notifications or other users' chats are written.

Handoff verification: 17 focused worker/Activity/Project-GPT tests, including changed
PR head, Unicode byte bounds, revocation, private routing, changed chat binding and
frozen evidence retries. Chromium and WebKit exercise the actual private GPT outbox,
existing chat/draft reuse, lost acknowledgement followed by window reopen and retry
(one native send), plus context-chip geometry in four themes on phone/tablet.
Real Windows read-only commit and Issue evidence reads also passed; native GPT sends
were exercised with disposable fixtures, not the owner's live chats.

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


## Shared events and directed GitHub attention — 24 September 2026

The same chronological feed now includes explicitly published Space Results and
atomic collaboration changes: creation, join/leave, project add/remove, access
request/change. Metadata changes are recorded in the same transaction and receipt
as their source operation; retries cannot create a second event. Keep at most 500
metadata events per Space and return 200 combined events. Private native turns,
checks, Results and personal Work Reviews are never published automatically.
Shared Result entries are a live projection of existing immutable share grants,
not another file store; revoked grants disappear on refresh and all viewer/content
requests reauthorize the grant and destination membership. Existing shared grants
are included; historical membership changes from before this release are not
invented. Removed projects leave a generic fact without a stale repository title.

Project and author filters cover both sources; Hub people and GitHub identities
use separate namespaces. Cached local events use the same bounded account-local
Activity view. Source keys, mounted cards, selected filters and scroll anchors
survive refresh. The shared Result opens the existing universal viewer above the
feed. Access changes generate a recipient-only notice in the existing Notifications
window; subsequent changes for the same recipient/project coalesce. Ordinary
membership/project/Result entries remain quiet (the original publication may still
count as an unread Space chat message).

Canonical GitHub activity reads include numeric-identity assignments and requested
reviewers. The five most recently updated open PRs also receive a bounded public
CI summary for their exact head: check runs plus combined commit statuses, at most
50 of each. Missing, failed or paginated reads are not treated as successful CI.
Failed runs require attention only for the PR author or assignee. Team review
requests are not guessed to belong to individual users. Native source reads still
use each viewer's own checkout/account and the existing 60-second refresh floor.

Opening Notifications serially refreshes the linked projects the viewer can read;
closed Notifications do not poll GitHub. The observed recent source window remains
bounded to 30 Issues and 30 PRs; this is not an exhaustive assigned-work search or a
push notification subscription. Sources outside the latest observation lose cached
attention/CI claims. A changed numeric GitHub viewer cannot reuse previous cached
attention. One or two explicit buttons open the integrated GitHub viewer or mark
that exact notification read. The latter persists only a bounded local receipt
(user/Space/project/numeric repository/numeric viewer/source/version), never a
GitHub acknowledgement, assignment, review or check mutation. A new failed run or
PR head has a new version; unrelated comments do not resurrect an acknowledged
request. The global bell retains its existing cheap local sources; native GitHub
attention is discovered when its window opens.

Focused verification: 26 backend/worker checks pass, including public-source
projection, no publication on private capture, replay deduplication, revoked
access/grants, numeric recipient identity, new CI attempts and local-only read
receipts. Chromium/WebKit cover local/GitHub feed continuity, exact internal
source inspection, Result viewing and notification acknowledgement. Four-theme
phone/keyboard/tablet screenshots are inspected. The actual installed Windows
GitHub worker is updated at idle with a verified backup and exercised read-only
through Hub → SSH → Scheduled Task; matching release hashes are required.
Physical-device acceptance remains pending. Private Work Review publication and
an exhaustive GitHub event history remain separate scope; #218/#205/#197 are not
claimed fully closed by this release.
