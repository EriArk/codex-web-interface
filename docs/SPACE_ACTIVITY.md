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
