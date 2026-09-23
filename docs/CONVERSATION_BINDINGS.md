# Conversation bindings — foundation (#209)

The 23 September 2026 stage introduces a shared durable binding model and moves existing personal Project GPT onto it. It is the prerequisite for Intake (#210) and Issue Drawer (#211), not completion of every role in #209. Current/Previous Work, Bridge Coordinator and Doctor retain their existing registries until their own bounded integration passes. No new utility chats, automatic prompts, generic role picker or background native discovery are introduced here.

## Identity and authorization

`ConversationBindings` lives in each private runtime database. The Team host supplies the exact authenticated owner's user ID; the standalone single-user runtime uses its explicit `local-owner` principal. Opening a populated registry as another owner fails closed. Conversion of an already-populated standalone binding registry to a Team principal requires an explicit ownership migration; it must not be guessed from names.

A binding has an exact provider, scope/object ID, role, lifecycle, visibility, optional machine/checkout, native conversation ID, creation/send receipt and revision. The identity key includes owner, provider, scope, object and role. Descriptors cover Codex and GPT; Project GPT uses `gpt / project / companion / persistent / normal`. Ordinary GPT chats need no binding. A stored visibility flag is a contract for later consumers, not a new chat-list filter in this stage.

The registry never grants permissions. Routes still use the personal runtime and current project catalog. Project GPT mutations recheck execution authority. Native and legacy browser outboxes check the exact Project GPT revision/target before preparation and again before submission; already-submitted receipts remain readback-only. New sends also freeze stable collaboration scope IDs, repository and access, rechecked after asynchronous preparation. Renaming a project or Space does not invalidate its identity. Removing/changing membership or replacing the target does not redirect queued input into another chat. Previous releases' accepted receipts retain their existing authorization and recovery semantics; they are never replayed to add the new scope snapshot.

## Migration and recovery

`ai_conversation_bindings`, `ai_conversation_binding_history` and `ai_conversation_claims` are additive private SQLite tables. Existing `project_gpt_bindings` rows import transactionally once, retaining exact native ID, job and revision. The old table remains the source of personal rules; its old binding fields are frozen migration provenance, never an ongoing second authority. `project_gpt_sends`, native history and durable outbox receipts are preserved. New `project_gpt_send_authority` rows accompany new send intents atomically.

Binding history retains each explicit revision and its latest exact job resolution. Claims retain the conversation's original semantic scope after unlinking: a chat once used for one Project cannot silently carry its memory into another Project, Room or role. Pre-existing duplicate legacy assignments are imported without choosing a winner; new dispatch through those ambiguous bindings is blocked until separate chats are explicitly chosen. Old native history remains available through ordinary GPT.

Lost creation acknowledgement resolves only from the existing exact job receipt. A pending/unknown first creation cannot be detached to create a second conversation. A pre-crash intent that was never accepted cannot later create a second chat after another first send settled. A late receipt cannot overwrite a newer explicit revision. Deleted native chats retain their binding identity and cannot cause automatic replacement; the existing Project GPT settings allow explicit selection of a new/separate chat. Selecting the same current chat is a no-op. Project rename/archive and binding changes never delete native history or stop submitted work.

## Verification and release

Focused tests cover legacy import/restart, rules and revision preservation, exact scope/owner isolation, cross-project/role/Room claims, explicit checkout changes, duplicate legacy assignments, stale native receipts, pending/unknown creation, pre-crash intents, deleted chats, and binding/project/user/membership changes during native preparation. Existing native dispatch and Activity handoff tests retain at-most-once and authorization coverage. The real Team routing fixture checks both runtime owner identities.

Project GPT browser checks run in Chromium and WebKit: explicit chat selection, one native fixture send, completion, draft/history restoration across close/reopen/reload, rules, Results, four themes, phone/tablet widths and keyboard-constrained height. These use disposable fixtures, not owner conversations or physical iOS acceptance. No production AI prompt is sent for verification.

The Windows transport/helper contracts are unchanged. The installed GitHub worker from the preceding Activity stage remains applicable. The Hub release still requires the ordinary all-user idle guard, fresh coordinated backup, production-image smoke and whole-checkpoint rollback; an old engine must not be started against newly-written binding state without restoring its checkpoint. A built/queued release is not an installed release.
