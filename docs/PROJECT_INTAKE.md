# Project Intake — incoming engineering analysis

Implemented on 23 September 2026 for #210. This stage follows the minimal conversation registry in #209; [Issue Drawer #211](ISSUE_DRAWER.md) adds explicit collection and reviewed publication of selected completed answers.

## User flow

Open **Разобрать входящие задачи** from the Project overview, or **Изучить в Codex** on a Space Activity item with a connected personal working copy. The themed window stays above the mounted working conversation. Closing it preserves both the ordinary chat draft and the Intake draft, references and edited handoff.

Each user/project has one persistent native Codex Intake chat, classified as a utility conversation. It does not appear in ordinary chat lists or become Current/Previous Work. The analysis uses native read-only sandboxing, no approval elevation and no Relay write tools. Generic send, queue, settings, fork and resume routes cannot bypass its utility role. Questions can be answered in the window. Public completed analysis appears in paged history; internal tool output and hidden reasoning are not displayed as chat messages.

Requests may include up to five exact issues, PRs or full commit hashes from that project's repository. GitHub URLs and `#42` are accepted; Activity supplies the selected source directly. Evidence uses the participant's existing Windows/Linux GitHub worker and own checkout. Each source is bounded to 4,000 characters; the frozen analysis envelope is limited to 32,000 characters. These fragments are explicitly identified as incomplete, untrusted source data. No foreign private AI history is imported. Source buttons open the integrated GitHub viewer, with repository name, numeric identity and exact item checks.

Completed answers offer **Подготовить к работе**. The user edits the proposed package (up to 6,000 characters including source links), then reviews the existing Project Action and explicitly selects **Подтвердить и запустить**. Intake itself never submits implementation work. The resulting ordinary Plan/Project Action targets Current Work through its existing policy checks, queue, receipt and review flow. It retains the precise Intake message/turn backlink and source references.

Message rendering and Results reuse the existing Codex components: blocks through 20 logical lines stay in chat; longer completed blocks keep an exact clickable reference, copy controls and original bytes. Images/files keep the established private artifact boundaries.

## Recovery and isolation

- Binding scope includes the private runtime owner, project, machine and working directory. Shared access is checked again around asynchronous preparation and before native dispatch. A changed checkout requires explicit rebinding.
- Native creation has a durable receipt before dispatch and records the exact returned native ID before later naming work. Unknown creation is never retried as another native creation or recovered by title/latest-chat guessing. Recovery accepts an explicitly selected separate idle native chat of this project; Current and historical Work chats are rejected.
- Unknown sends retain their original idempotency key. Native recovery must match exact user-message/turn identity; matching prose alone cannot acknowledge an Intake send. A deleted native chat keeps its binding until explicit replacement.
- Handoff retries reuse the same Plan and Project Action. Browser receipts are account-local; Hub receipts persist in the user's private SQLite database. No native destructive action or external publication is part of Intake.
- Opening/polling Intake reads bounded local state; it does not create a native chat. Canonical history is loaded on opening and explicit older-page requests, not every poll. Utility work remains visible to the existing maintenance idle checks.

## Verification and release

Focused tests cover binding reuse, read-only dispatch and bypass protection, unknown creation/send acknowledgements, changed checkout/access, deleted native chats, exact evidence, and one explicitly confirmed Work handoff. Existing bindings, Project GPT, Project Work, Bridge Doctor and Activity tests also pass.

Chromium and WebKit fixture acceptance covers internal source inspection, separate drafts and review retention, short/long block continuity, lost handoff acknowledgement, and a single confirmed Work submission. Geometry is checked in all four themes at phone, keyboard-constrained phone, portrait tablet and wide tablet sizes. This is automated browser/native-transport fixture evidence, not a claim of physical iPhone/iPad or live Codex model acceptance.

No Windows helper contract changed: existing `githubWorkProbe.js` evidence/detail operations are reused. Hub packaging and guarded installation remain separate from verified source completion; ordinary installation waits for active work.
