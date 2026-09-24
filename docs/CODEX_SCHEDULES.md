# Chat-bound Codex schedules

The clock in the current Codex Project chat and the persistent Intake header opens
the same themed schedule window. Create one-time or selected-weekday messages,
edit, pause/resume, or cancel there. Immediate composer drafts are separate;
schedule drafts are bounded, account-local and keyed to their originating surface.
No Project picker or global scheduling module is introduced.

## Targets and authority

The private conversation-binding registry identifies Project Work and Intake.
Work follows the explicitly confirmed Current Chat through rotation. Creating
the first schedule from an existing Project chat confirms that chat only when no
explicit Current Chat exists. A historical non-current chat cannot silently
replace the confirmed target. Intake requires its exact persistent native binding,
revision and read-only send policy. Unassigned conversations, future Assistant
roles, Bridge and hidden job workers are not schedule targets in this pass.

An occurrence rechecks the active account, exact Project ID, execution-machine
configuration, checkout path and current collaboration binding. A changed binding
requires a new schedule. Revocation or an unavailable target pauses future work;
it cannot redirect to another Project with the same name. Browser closure does
not stop scheduling: the Team Hub already restores active private runtimes.

Messages contain text/Markdown and ordinary textual reference links. There is no
attachment picker or retained file capability: a schedule does not fetch,
snapshot or re-share linked file contents. The destination supplies normal context.

## Time and delivery

Store the named IANA zone, local date/time, selected weekdays and next UTC instant.
An empty weekday set means one-time. Daily is all seven days, weekly is one day.
For repeated daylight-saving time, use the first instant once. A nonexistent
one-time wall time is rejected; recurring rules skip that day. The list shows the
next instant in the viewer's local timezone alongside the rule's timezone.

Due work runs through the existing queue mutation lock and normal `startTurn`,
with a UUID receipt committed at its `beforeCommit` boundary. It waits behind
native queue items, active work and desktop handoff; it never interrupts or takes
an active writer. Waiting occurrences retain their order. Recurrence coalesces
missed dates after downtime into one pending occurrence, then computes the next
future local occurrence, avoiding a burst of stale messages.

Every occurrence has an independent persistent receipt. A crash after the send
boundary becomes unknown and is never replayed. Native user items from live
events or bounded canonical-history reads reconcile only the exact UUID and
native conversation. An optimistic local message or a similar text is not proof.
Recurring future occurrences remain separate. Native acknowledgement means
“sent”, not successful completion of the requested work.

Edits/pause/cancel use revisions and are rechecked immediately before native
submission. An in-flight submission cannot be withdrawn by deleting its schedule.
Terminal occurrence history is retained for 90 days; the latest and uncertain
receipts remain. The private namespace allows at most 1,000 stored schedules;
the chat window lists at most 100. Failures/unknown sends use existing quiet
in-app/PWA attention, without success notifications from the scheduler itself.

Backup restoration pauses future schedules and marks pending occurrence receipts
unknown. A restored older database is not permission to resend something that
may have run after the backup. Normal process restart preserves waiting work.

## Verification and release

Focused tests cover actual route-to-native Work rotation and Intake read-only
delivery, duplicate keys, recurrence, queue waits, revision/cancellation races,
revocation, restart/lost acknowledgement, exact reconciliation and DST.
Chromium/WebKit checks cover management, separate drafts, all four themes, phone,
keyboard-height and tablet viewports. Device acceptance remains owner usage.

The additive tables live in each existing private SQLite checkpoint. No new
Windows helper contract, listener or native application restart is required.
