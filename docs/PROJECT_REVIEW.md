# Project work review

Schema 21 adds one Review per completed implementation action, plus transactional owner-decision receipts. It freezes the exact Codex turn or GPT job's public final answer and up to 80 existing Results. Check counts describe recorded command exit codes, not inferred test coverage. Cached Git metadata retains its observation time; opening Files/Git explicitly inspects current state.

Completion, observed verification and owner acceptance are distinct. Failed, cancelled or unknown actions cannot become ready for acceptance. Late final projections can populate a missing Review, but later Git/Result changes never rewrite an already captured snapshot. Reads use bounded Hub storage only. Reviews survive plan/chat deletion and appear in later report/rotation context.

Accept and Needs fixes update only owner metadata with explicit revisions and atomic idempotency receipts. Needs fixes preserves a short local draft, records the owner note and can prepare a separate correction action. Preparation binds the current confirmed chat, Review revision and existing model/effort settings. Submission rechecks those identities and uses the ordinary native queue/send receipts and ownership guard. An uncertain submission is never replayed. No additional model invocation occurs on capture or acceptance.

The same responsive Review dialog is opened from a completed project action, its source turn or Project Overview. Existing source/Results/Plans/Files navigation is reused. Closing the dialog preserves the chat and its draft. iPhone uses one list/detail view; wide tablets use a bounded split layout.
# Plan reconciliation

An implementation prompt names each item in the exact saved Plan revision and requests one bounded `codex-plan-result` JSON block in the public final answer. Hub validates its schema, Plan identity/revision and item identities. Missing, malformed or unrelated payloads produce unknown items; prose is never treated as proof. No extra native turn is launched.

The immutable proposal belongs to the captured action/Review. `complete` means a completion claim, while `verified` also requires exact recorded successful command evidence from this work; failed or truncated command observations do not qualify. The UI preserves partial, unknown and not-done states, original checked items and evidence links. It does not claim that a successful command proves arbitrary product behavior or physical-device acceptance.

Accept and Apply are separate actions. After accepting, the owner selects complete/verified items. One SQLite transaction checks the current Review and exact Plan revision, saves only those selected checks in one new Plan revision, and writes the proposal receipt. Exact lost-ack retries return the same saved response. Changed/deleted Plans are not overwritten or recreated. Human Tasks and Core are untouched; Overview/Reports/rotation read the normal saved Plan state. A correction preserves the original Plan snapshot, so a later Plan edit still requires explicit conflict resolution.
