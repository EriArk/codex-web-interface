# Remaining work after Brainstorm — 24 September 2026

This is a scope review, not a new functional or physical-device acceptance run. The GitHub catalog contains **64 open issues**. The review compares current issue requirements, the previous audit, implementation documents and the relevant UI/routes. An open tracker is not evidence that its entire feature is missing. Issues were not closed or commented on.

Live deployment was checked read-only: engine **`ed675e9`**, maintenance receipt **installed**. This includes the completed Brainstorm touch correction. Earlier roadmap entries naming `dab5060` or a waiting Brainstorm release are historical. Documentation changes from this review do not require another deployment.

## Implemented foundations to preserve

| Area | Implemented scope and evidence | Remaining distinction |
| --- | --- | --- |
| Files/editor, #169 | Writable file management, CodeMirror, exact-version conflict/collision choices, batch operations, ZIP download; [file editor](FILE_EDITOR.md) | Do not rebuild the editor or silently replace existing files |
| Viewers, #167/#184 | Shared themed workspace for text, images, PDF, isolated HTML/SVG, media and supported CAD/3D formats; [formats and limits](FILE_VIEWERS.md) | No user-facing converter; Office/archive inspection is download-only; wider real-device/DXF acceptance remains |
| Activity, #218 and part of #197 | Internal GitHub source viewer, commit grouping, quiet refresh, reactions/replies, exact Project GPT/Intake handoff; [Activity](SPACE_ACTIVITY.md) | Not a complete event history: default-branch commits and recent Issue/PR state are indexed; Result/Review and membership/access event coverage is not complete |
| Project GPT / Intake / Issue Drawer, #200/#210/#211 | Persistent private bindings, bounded source evidence, read-only Intake, reviewed multi-repository Issue publication and receipt recovery; [bindings](CONVERSATION_BINDINGS.md), [Intake](PROJECT_INTAKE.md), [Drawer](ISSUE_DRAWER.md) | Real participant publication acceptance is separate. The minimal binding registry does not complete every role in #209 |
| Brainstorm, #203/#212/#204 | Rooms, board/chat, private room GPT, voice baseline, selected immutable snapshot and Project handoff; direct manipulation and touch fixes; [Brainstorm](BRAINSTORM.md) | Physical-device gestures/audio and real usage remain acceptance items. Full Fluxer parity is not implemented or required by this baseline |
| GPT history, #188 | Hub/browser suffix deltas, changed-message Results projection, bounded retained state and unchanged DOM; [incremental history](GPT_INCREMENTAL_HISTORY.md) | Native canonical graph reads/normalization remain; there is no durable incremental native ingestion store |
| Spaces / project contracts, #215/#195/#207 | Existing participant checkouts, invitations, shared navigation, optional CODEXWEB.md preferences and automatic Write for owner-selected full access; [Spaces](COLLABORATION_SPACES.md) | Do not restart member provisioning or mistake Write for Admin. Further downgrade/removal work stays deferred |

The earlier [20 September audit](ISSUE_AUDIT_2026-09-20.md) retains the detailed legacy defect inventory. Its Canvas and automatic Work Report plans are superseded and must not be restored. This review does not newly reproduce every old defect or claim all 64 issues satisfy their acceptance criteria.

## Concrete product gaps

1. **Prepare for Codex, #201.** Brainstorm can create a Project and provide a snapshot, but there is no complete reviewed flow from the settled Project GPT discussion to a repository documentation/reference package, initial Issues and exact Codex handoff. Existing file editing and Issue Drawer publication are useful building blocks, not this finished workflow.
2. **Independent human conversations and Result forwarding, #202/#213.** Current human-chat routes are scoped to a Space or Brainstorm room. There is no complete DM/small-group surface or general Results destination picker with audience-bound immutable grants. `SharedPublication.tsx` already publishes selected project materials; it is not general rich Result forwarding. Implement these related user flows together, preserving HTML interactivity and technical viewers, current authorization, revocation and shared retention.
3. **Managed copy synchronization, #198.** Participant copy provisioning and ordinary Git ahead/behind views already work. The remaining work is durable base/provenance, detecting upstream changes, explicit safe update/reconciliation and conflict UX; optional isolated test services follow that working core. Never overwrite a participant's changes or recreate their checkout as a shortcut.
4. **Activity/attention completion, #218/#205/#197.** Add missing meaningful sources only as their workflows exist: shared Results, Reviews, collaboration state changes and review/test decisions. Keep ordinary events in Activity, directed requests in Notifications. A second parallel Inbox store or noisy bell is not required.
5. **Codex scheduled messages, #214.** The existing `ScheduledPanel.tsx` reads `/gpt/scheduled`; it does not implement the requested Codex chat-bound one-time/recurring sends. This needs its own exact binding, timezone, cancellation and uncertain-send handling.
6. **Advanced project profiles, #208.** Optional CODEXWEB.md instructions exist. The full template/structured profile editor across Project creation and GPT/Codex is a separate remainder; preserve user AGENTS.md and do not make the ordinary wizard larger by default.

Later work remains: the global typed assistant (#206), broader role lifecycle integration (#209), server-workspace/installer consolidation (#170/#173/#11), shortcuts and help (#177/#174), and user-facing file conversion. The converter was explicitly described as later work, not authorized for this stage. Remote replacement (#182) requires a demonstrated benefit. Physical-device acceptance (#10) remains owner usage work and does not block unrelated implementation.

## Recommended next stage

**#201 — Prepare for Codex**, reasoning **Высокое (`high`)**.

It completes the freshly implemented idea → room → Project chain. Deliver one coherent flow:

- choose the settled discussion and exact shared snapshot/materials;
- inspect existing repository content and present a compact editable file/Issue plan with diffs;
- preserve CODEXWEB.md and AGENTS.md, expose exact file collision choices;
- after explicit in-app review, apply through the acting user's existing typed repository and Issue operations, with persistent receipts and reconciliation of unknown outcomes;
- open the exact prepared Project in Codex without automatically starting implementation;
- include recovery, themed phone/tablet layout, focused tests, and any affected installed Windows helper update in the same release.

Do not create another Issue publisher or a generic arbitrary-write AI tool. Reuse Issue Drawer, normal Project setup and existing permission boundaries. The exact integration design and helper contract changes belong to the next approved implementation session. Wait for the owner's continuation before starting it.

After that, propose **#202 + #213** as the next connected communication stage rather than repeatedly adding disconnected send/share buttons.


## Activity/attention pass completed — 24 September

After Prepare for Codex, communication/Result forwarding and managed checkout
sync, the fourth recommended pass now includes shared Result and collaboration
metadata events, exact-head CI summaries and directed GitHub assignment/review/CI
attention in the existing Notifications surface. See [coverage and bounds](SPACE_ACTIVITY.md).
It also includes the owner's requested direct file/image viewing in Results.
Private Review publication and exhaustive GitHub history are not auto-enabled.

Next proposed pass: **#214 — Codex scheduled messages**, **Высокое (`high`)**.
Keep it chat-bound, with timezone/recurrence editing, cancellation, exact account /
machine/thread binding, durable receipts and uncertain-send reconciliation.
Wait for the owner's continuation before starting that pass.

## Codex schedules pass — 24 September

The #214 Project Work / persistent Intake scope is implemented: chat-toolbar
one-time and weekday schedules, named zones, confirmed Current Chat rotation,
revision-bound management, native queue ordering and exact uncertain receipts.
See [behavior and bounds](CODEX_SCHEDULES.md). Assistant/Bridge roles that do not
yet exist as supported chat surfaces remain outside this pass.

Next proposed stage: **#208 — advanced project profiles**, **Высокое (`high`)**.
Unify optional project instructions, reusable profile selection and its compact
editor across project creation and GPT/Codex. Preserve existing AGENTS.md and
keep the ordinary creation flow small. Wait for the owner's continuation.

## Project profiles pass — 24 September

The #208 structured profile editor now spans optional project creation (including
Brainstorm handoff), Project Overview and Project GPT. It includes eight templates,
exact CODEXWEB preview, review/apply, personal drafts, conflict protection and
receipt-based recovery/cancellation. See [behavior and verification](PROJECT_AGENT_PROFILES.md).
Personal CODEXWEB remains excluded from Git under the existing owner decision.

Next proposed stage: **#206 — global typed assistant**, **Высокое (`high`)**.
Start with project/source selection and a reviewed handoff to existing GPT/Codex
tools. Preserve their exact identities, drafts and authorization; do not create
an unrestricted shell or another parallel task executor. Wait for continuation.


## Owner-selected remaining-work order (24 September)

The owner declined the global assistant (#206); it is not the next stage.
The agreed order is **6 -> 2 -> 4 -> 1 -> 5** from the remaining-work list:

1. **6: Larger GitHub text and directory operations** — implemented together
   with durable drafts, Windows transport/helper updates and recovery; see
   [File editor](FILE_EDITOR.md).
2. **2: GPT native history** — incremental history storage/processing, avoiding
   repeated full-chat processing while preserving message/result identities,
   receipt isolation, partial responses and fast cached navigation.
3. **4: Activity and Notifications** — finish remaining event coverage through
   the internal viewers with continuous feeds and account-local caches.
4. **1: Archive and Office viewers** — extend the universal file workspace.
5. **5: Help and shortcuts** — contextual in-app help and a concise shortcut list.

Installation/maintenance consolidation (old item 3) is not in this queue.
The next proposed stage is **2, GPT history**, **Высокое (`high`)**. Wait for
continuation before starting it. Converter work remains deferred.


## GPT history and input/file follow-up (24 September)

Stage **2** is implemented with incremental Hub normalization and disk journals,
shared 4-to-8-line multiline inputs and owner-requested file-limit alignment.
Native upstream full-graph reads remain; see GPT_NATIVE_LINUX.md and FILE_EDITOR.md
for exact behavior, boundaries and verification.

Next proposed stage is **4: remaining Activity and Notifications coverage**,
**Высокое (`high`)**, followed by **1 -> 5**. Wait for the owner's continuation.

## Activity/Notifications continuation — 24 September

Stage **4** now includes exact-head GitHub review decisions and directed requests
for changes, quiet Space rename/removal events, and bounded account-local
Notifications caching/deltas/scroll with transient-failure continuity. Verification
and the observed-history boundaries are recorded in SPACE_ACTIVITY.md. This does
not create mandatory reviews, automatically publish private Work Reviews or claim
an exhaustive GitHub event history.

Next proposed stage: **1 — archive and Office viewers**, **Высокое (`high`)**.
Extend the universal file workspace with bounded archive inspection and document
viewing, preserving original downloads, editor entry points and private source
boundaries. User-facing conversion remains deferred. Then **5 — help/shortcuts**.
Wait for the owner's continuation before beginning the next stage.
