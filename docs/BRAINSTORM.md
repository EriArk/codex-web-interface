# Brainstorm rooms

Implemented stage, 24 September 2026, following #203, #204 and #212.

## Product flow

Shared → Brainstorm lists rooms for every active installation user. Creating a room requires no checkout, machine or repository. Following and muting affect attention, not access. The creator can rename, describe and close/reopen the room. Closing leaves its materials readable and prevents new edits, chat/GPT sends and voice entry.

The mounted room has Board, Common chat and My GPT tabs. A wide board stores positions and supports dragging and keyboard arrows; phone cards form a readable single column. Cards contain notes, links, immutable files/images/PDF references or simple freehand strokes. Editors retain account-local drafts and use exact revisions; a concurrent edit must be reviewed before replacement. File inspection uses the common internal viewer. Common chat reuses paged, durable Space chat with a separate namespace. Switching tabs retains its messages, scroll and draft.

My GPT is a persistent private **user × room** binding. It never borrows a Project GPT or another room's binding. Opening does not send. The normal explicit send uses the actor's native GPT account/outbox, with a bounded current room context and frozen retry envelope. Room text is untrusted source material. File names/references do not imply that binary content was read. Existing ordinary attachment controls remain available. A completed public assistant response can be reviewed and explicitly published as a board card; private conversation history is not broadcast.

The creator saves an immutable selection of cards and recent common-chat messages before opening the existing create/connect Project wizard. A snapshot has one exact setup receipt, restored on reopening or another device. Completion requires that receipt's completed project identity. Only a prepared, undispatched review can be reset to edit parameters; running/uncertain operations retain normal reconciliation. The normal Space invitations carry selected collaborator/Write choices. Invitations never borrow a participant's identity or waive actual GitHub access rules.

The resulting project has a separate personal GPT binding with bounded shared snapshot context. The creator may include an explicitly entered private summary; it goes only to their own Project GPT. Other accepted participants receive the shared snapshot through their own Project GPT context. No native GPT task is started simply by opening or converting a room. The room remains available, with internal project navigation for participants who have access. Export is a ZIP of selected originals, Markdown and JSON provenance/layout, with a 64 MiB binary limit. It excludes private summaries and audio and is not automatically committed to Git.

## Voice

A small authenticated Hub WebSocket relay transports mono 16 kHz PCM in bounded 40 ms frames. This stage uses existing Hub transport and browser AudioWorklet rather than adding a Fluxer server/SFU/TURN deployment or its unrelated channels/roles. There is no extra public port or Windows listener. Audio is ephemeral and is never stored or placed in snapshots.

Up to eight room participants can explicitly join, enable/disable their microphone, deafen and leave. Joining starts muted. Frame size/rate, client buffering, playback queues, room/global peers and heartbeat lifetime are bounded. Origin, session and exact workspace identity guard upgrades; account revocation closes tracked sockets, and room closure is rechecked. Leaving, failure or unmount stops microphone tracks and closes the AudioContext, including late permission responses. An active voice call blocks ordinary idle deployment. There is no automatic microphone reconnect after a disconnection.

This is a small-team audio implementation, not a claim of Fluxer feature parity. Physical iPhone/iPad audio quality, Bluetooth routing, background behavior and long-distance latency remain owner acceptance work.

## Persistence and recovery

- Shared room/card/chat/snapshot tables live in the Team SQLite database. Private GPT intents and Project GPT handoffs live only in each user's personal database.
- Board updates use a bounded change journal; polling preserves unchanged DOM and image URLs. Published files retain hashes and exact source IDs; staged uploads remain private to their uploader.
- Bounded limits: 100 created rooms per owner, 200 active cards per room, 100 snapshots per room, 2,000 drawing points per card, 32 MiB per attachment and the existing namespace storage quota.
- Team checkpoint/verify/restore now covers **both** ordinary Space chat and Brainstorm attachment namespaces. It verifies referenced bytes and hashes instead of silently producing a database-only chat backup. Legacy checkpoints with referenced but absent chat bytes fail verification.
- Windows helper contracts are unchanged. Project creation, repository inspection and Write invitations use the existing installed helpers; release verification checks their compiled hashes against installed-machine evidence.

## Verification

Focused Node tests cover public discovery/owner controls, user preferences, optimistic edits/deltas, restart, staged-file isolation, exact-byte exports, private-summary exclusion, two-user/two-room GPT separation, frozen retries/native creation recovery, closed-room sends, exact conversion receipts, invitation idempotence, bounded shared GPT context, voice isolation/deafen/bad frames, worklet limits and Team backup/restore with damaged bytes.

Browser fixtures use actual React components in Chromium and WebKit. They check mounted board/chat continuity, unchanged image requests, drafts, exact card edits, internal conversion windows, private GPT entry, four themes, phone/keyboard/tablet layouts, plus synthetic audio and microphone resource cleanup. Screenshots are inspected as well as measured. Native accounts, real repositories, the owner's microphone and active work are not used by these tests. Physical-device acceptance remains pending.

Not claimed complete: optional board arrows/grouping, a full collaborative drawing editor, transcript/audio recording, bulk historic room-chat selection, automatic binary ingestion into GPT, or automatic private-summary extraction. Advanced room workflows can be extended after real usage; the stage does not close every acceptance detail of the umbrella issues.

### Follow-up verification, 24 September

The room-to-project wizard now restores its exact server receipt before enabling edits, including on a device without a saved wizard draft. Applying initial room defaults no longer clears that recovery identity. A lost completion acknowledgement retains the completed setup and retries only the handoff, without preparing or executing another project. Browser fixtures exercise this through the actual room and Project wizard in Chromium and WebKit.

Voice connection can be cancelled while permission or module loading is pending. Pending audio contexts/tracks and late permission responses are released without connecting. Playback drops departed participants' queues so later participants remain audible after repeated joins/leaves. Synthetic browser audio and worklet tests cover these cases; screenshots also cover active voice at keyboard height and compact-tablet layouts. Physical-device sound/routing acceptance remains pending.
