# Conversations and Result sharing

Implemented 24 September 2026 for #202/#213. Installation is recorded separately by the guarded release receipt; physical-device acceptance remains pending.

## Entry and conversations

“Общение” is in the lower workspace shortcuts in Codex and GPT, beside Tasks, Notes and Notifications. Reports was removed from that row at the owner's request. The Space chat keeps its separate header entry. The communication window opens above the mounted personal workspace; nested file and GitHub viewers preserve it.

A direct conversation is canonical for the two verified Hub users. Groups contain 2–8 people and do not require a Project, Space or Brainstorm. Current membership gates all history and file access, including administrators. Participants can mute or leave. Leaving does not let another participant silently restore access; editing membership and reinvitations are not included in this stage.

Messages use durable exact-input receipts, recent/older pages and incremental suffix reads. Drafts are account-local and conversation-specific. Files retain their original bytes, images have thumbnails, mentions select real current participants, and unread counts appear in Communication and Notifications. At most five visited conversations stay mounted per window. Files are limited to 32 MiB each; conversation storage is bounded to 1 GiB. The conversation list is bounded to 200 active entries per user.

Project and room references open the integrated workspace; Issue/PR links open the integrated GitHub viewer through the reader's own compatible working copy. An external GitHub link is secondary. References never grant project or repository access.

## Immutable materials and audience

The Result action “Отправить” captures exact canonical bytes through the sender's own runtime, including completed file/image/artifact/HTML-demo Results. A sender can also forward their own published conversation attachment. It accepts source identities, never client-provided file paths or arbitrary download URLs.

The captured object stores SHA-256, type and title. Private paths and source conversation IDs are not exposed in recipient cards. Human destinations reference that object through separate grants rather than creating a file copy per recipient. Destinations are a person/direct conversation, group, Space chat or Brainstorm chat. Brainstorm requires an explicit acknowledgement that all current Hub users can read the room. Current destination access is checked on every download and preview. The source owner can revoke an individual destination from the Result picker; other grants remain usable. An already downloaded copy cannot be recalled.

The grant, message and send receipt commit atomically. Retrying an uncertain send uses the same input and receipt. Removal of the original private Result does not erase previously captured bytes. Each snapshot is at most 32 MiB, with a shared 1 GiB storage budget. Automatic retention/garbage collection and a global share-management screen are not included; grants are managed from the original Result action. Captured files and conversation files participate in Team checkpoint, integrity verification and restore.

Recipients use the existing universal file viewer. Interactive HTML retains the existing isolated preview CSP: scripts can run inside the sandbox, without same-origin privileges, network access, frames, forms or storage. The current source preview model captures a single self-contained document; multi-file sidecar packaging is not added by this stage. Revoking a grant removes an open preview on its next authorization refresh and immediately prevents new reads.

## Own GPT destination

A material can be prepared for an existing chat in the sender's own native GPT catalog. Normal Project/Brainstorm GPT bindings use the same path. A chip appears beside that exact chat's composer; explicit attachment staging copies the verified snapshot bytes to the owner's native upload store. It preserves the snapshot ID/hash and uses a stable upload identity. The owner then sends normally. Draft text is never replaced and no native turn is submitted automatically. Binding changes or hidden utility chats reject the handoff. Intake/Work utility attachment handoffs and forwarding another person's shared grant are not included.

## Verification and operations

Focused Linux server tests cover canonical DMs, reciprocal creation, exact retries, third-user isolation, incremental history, unread/mute/leave, private attachments, mentions, original-owner forwarding, immutable snapshots, grant revocation, public-room acknowledgement, sandbox headers, exact GPT upload staging and changed-binding rejection. Team checkpoint verification and restored snapshot bytes are checked, including tamper rejection. Existing Brainstorm and Space regressions run with them.

Chromium and WebKit exercise two authenticated users, draft restoration, Result forwarding, public-room audience selection, interactive sandboxed HTML, per-destination revocation and unaffected second grants. Screenshots cover all four themes, phone, keyboard-constrained phone, portrait/landscape tablet and wide tablet. These are automated browser checks, not physical iPhone/iPad acceptance.

This stage changes Hub storage/routes and shared web UI. It does not change the Windows helper contract; integrated GitHub reads reuse the installed worker. Use the existing idle-guarded coordinated release and retain backup/rollback. Do not restart native tasks to deploy it.
