# Current state

_Last reconciled: 2026-09-22 against `main` at `d5feae9a`._

This file is the short current-status map. It is intentionally not a historical audit. For exact deployment receipts and dated evidence, use [ROADMAP.md](ROADMAP.md), [VERIFICATION.md](VERIFICATION.md), [RELEASES.md](RELEASES.md) and the dated audits.

## Status vocabulary

CodexWeb keeps four states distinct:

- **Implemented** — present in the current source tree.
- **Verified** — covered by the cited automated or real-runtime checks.
- **Installed** — present on the live Hub/native runtime according to a deployment receipt.
- **Accepted** — exercised by the intended real users/devices/accounts.

Never infer a later state from an earlier one. In particular, current `main` is not automatically the installed production revision.

## Product today

CodexWeb is a private AI-development workspace centered on Projects rather than machines.

A personal workspace combines:

- native Codex projects, threads, Work/Plan mode, approvals, streaming and durable continuation;
- consumer ChatGPT/GPT projects and chats through the user's own private native/profile binding;
- Results, generated artifacts, explicit previews and source navigation;
- Files/Git, Project Core, Notes, Tasks, Plans, Reports, Review and Delivery;
- native work progress, diffs, context and live command output;
- Remote Desktop, device terminals, GUI previews, dictation and read-aloud;
- guarded updates, private snapshots, receipts, reconciliation and recovery.

Execution stays on the user's configured machine/runtime. The public browser talks only to the Linux Hub.

## Multi-user and collaboration state

The Team foundation is implemented around isolated personal runtimes. Each user keeps separate private stores, native identities, Codex/GPT sessions, machines, artifacts and background work. Shared membership never implies access to another user's private runtime.

Invitation-only member admission exists. Real owner/friend end-to-end acceptance remains a separate gate from disposable browser/native-transport checks.

[Collaboration Spaces](COLLABORATION_SPACES.md) is the current user-facing collaboration model. Current source includes:

- personal/shared workspace switching and compact Space navigation;
- two creation paths: one shared Project or a multi-Project Space;
- explicit asymmetric Project × participant access agreements;
- participant invitations, additional invitations and access requests;
- one human chat per Space with files/images/unread state;
- personal Project GPT bindings per user × Project;
- optional personal `CODEXWEB.md` preferences without modifying `AGENTS.md`;
- linked-project entry through each participant's own checkout;
- collaboration context injected into normal native Codex work;
- Git delivery checks that respect the current agreement.

The remaining #215 gate is real owner/friend use with actual machines, native accounts and GitHub permissions. Automated/disposable tests do not satisfy that physical acceptance.

## Open collaboration work after #215 source completion

Several older issues remain broader than the current Collaboration Spaces implementation and must not be considered complete merely because their basic UX now exists:

- **#195** — complete owner-authoritative read boundaries and writable integration-copy model across every relevant route.
- **#197** — make GitHub Issues/PRs/Reviews the canonical team engineering surface inside CodexWeb.
- **#198** — managed integration-copy lifecycle, sync/provenance and optional isolated test environments.
- **#196** — broader participant orchestration/readiness flow where capabilities beyond the current Space invite are required.
- **#199/#205** — Work Reports/feedback loop and a minimal unified Inbox after the canonical GitHub cycle is solid.

## Project GPT and CODEXWEB.md

The current source already implements the useful core of **#200**:

- one durable private Project GPT binding per user × Project;
- popup reuse of the normal GPT composer/history/results;
- bounded Project/Space context;
- draft isolation and retry-safe first-send binding.

#200 stays open for the broader GitHub/Work Report analysis and exact-source tooling described by that issue.

The current source also implements only part of **#207**. Personal collaboration preferences can be managed in a local `CODEXWEB.md` without touching `AGENTS.md`, but the full issue also covers automatic project-creation contracts, version/conflict management and a richer authenticated Runtime Access manifest. Those remain open.

## Results and message continuity

Current source includes exact generated-file/image reveal behavior and the newer chat/result continuity policy:

- supported internal artifact/file references open inside the mounted workspace rather than reloading it;
- exact source identity and authorization are retained;
- code/text blocks up to 20 displayed lines stay inline with copy controls;
- longer completed blocks materialize as Results and keep an exact link at their original message position;
- generated images remain visible in chat and Results;
- external web images use bounded thumbnails.

#168 (exact generated file/image reveal) and #183 (durable GPT text-block artifacts) were reconciled against their current regression coverage and closed as completed on 2026-09-22. #184 remains broader: its explicit Preview/responsive-format audit is separate from the unfinished Technical Viewer work tracked in #167.

## Bounded personal improvements still open

Useful independent improvements that do not require the second user include:

- **#175** per-user interface/text scaling;
- **#186** previous/next message and jump-to-latest navigation;
- **#169** conflict-safe writable text/code Files;
- **#214** one-time/recurring scheduled Codex chat messages;
- **#181** internal GitHub commit/Issue navigation;
- **#167** technical STEP/STL/DXF/SVG viewer.

These should be implemented as separate bounded passes rather than mixed into collaboration acceptance.

## Deferred larger stages

Still intentionally later:

- project-independent messaging and shared Result forwarding (#202/#213);
- Brainstorm rooms, room GPT and Brainstorm → Project handoff (#203/#212/#204);
- global AI helper and advanced behavior profiles (#206/#208);
- full in-app Help (#174);
- separate distributable Hub bootstrap (#11);
- Remote replacement unless a benchmark shows a clear benefit (#182).

## Documentation map

Use these files for different questions:

- [README.md](../README.md) — entry point, capabilities, deployment/development links.
- [VISION.md](VISION.md) — product model and enduring principles.
- [ARCHITECTURE.md](ARCHITECTURE.md) — runtime, trust and ownership boundaries.
- [ROADMAP.md](ROADMAP.md) — current milestone first, then dated implementation history.
- [COLLABORATION_SPACES.md](COLLABORATION_SPACES.md) — current shared-work UX and limits.
- [TEAM_WORKSPACE.md](TEAM_WORKSPACE.md) — private-runtime/team isolation model.
- [SECURITY.md](SECURITY.md) — security invariants.
- [VERIFICATION.md](VERIFICATION.md) / [RELEASES.md](RELEASES.md) — evidence and installed baselines.
- dated audits and [DECISIONS.md](DECISIONS.md) — historical records, not current-status shortcuts.
