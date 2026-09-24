# Project behavior profiles — 24 September 2026

Issue #208 adds an optional structured profile to personal Project setup and the
same editor to Project Overview and Project GPT. Brainstorm uses the ordinary
Project dialog, so its project handoff gets the same advanced settings. The
default wizard remains unchanged until Advanced settings is expanded.

## Behavior

Eight starting templates cover general, web, backend/API, desktop, CLI/library,
hardware/firmware, games and research. The owner can adjust quality, working
style, development order, verification, commits/publication, PR preparation,
documentation, autonomy, engineering priorities and custom instructions.
Changing a template preserves custom text. Disabling/re-enabling a profile in
the editor retains its unsaved values.

The preview shows the exact generated CODEXWEB.md bytes. Review compares current
and proposed preferences before applying. Existing optional project rules remain
editable in a disclosure and older clients cannot silently discard a structured
profile. Account-local drafts survive closing the editor without replacing the
conversation draft.

Codex receives the preferences with its next project instructions. Project GPT
receives the same profile as analysis preferences and retains its analyst role.
Saving is blocked during active/unknown project execution; it does not restart a
turn or dispatch a message. Profiles cannot grant access, authorize arbitrary
publication or override AGENTS.md and collaboration constraints.

## Personal file and recovery

CODEXWEB.md remains personal and excluded through Git's local info/exclude.
The personal-file decision in AGENTS.md/DECISIONS.md takes precedence over the
issue's suggestion to share profiles through Git. AGENTS.md, tracked files and
manually authored unmanaged CODEXWEB.md are never overwritten by this editor.

Hub stores structured rules, exact saved content, revision, machine/project/
authority binding and any pending write intent in private runtime SQLite.
Writes compare the reviewed revision, binding and SHA-256 file fingerprint.
The Windows/Linux probe checks the actual file again before replacement and uses
an atomic rename. A manual divergence is shown with saved/current/proposed text;
resolve it through Files before applying rather than silently overwriting it.
An unrelated external writer does not participate in the probe lock, so this is
not a filesystem-wide compare-and-swap guarantee.

An exact UUID receipt is persisted on the execution machine before mutation.
Probe writes are serialized per canonical project root. A lost acknowledgement
retains the intent; refresh reads the receipt/file and can confirm matching bytes
without replaying the write. Explicit cancellation acquires that same lock and
persists a failed receipt before clearing Hub pending state. A late original
request is then fenced off. Already applied bytes are retained and reconciled;
cancellation never rolls back the owner's file. Draft text remains available.

Project creation registers its confirmed project before applying the profile.
If this last step is interrupted, the existing setup receipt/project survive;
status reads do not falsely mark the profile phase complete. An explicit resume
uses the same setup identity and the profile's reconciliation rules.

## Verification and deployment boundary

- 33 focused backend tests cover templates, existing rules, role boundaries,
  revision/authority conflicts, busy projects, setup integration, lost responses,
  restart reconciliation, machine receipts and cancellation of delayed writes.
- WebKit and Chromium exercise editing, draft isolation, review/apply, uncertain
  save cancellation, manual file conflict and optional setup settings. Screenshots
  cover all four themes at phone, keyboard, compact tablet and wide dimensions.
- Existing Project GPT browser integration exercises native fixture send/final,
  close/reopen/reload and the unified rules editor.
- The candidate probe is verified through the real Hub → SSH → Windows path in
  a disposable folder: read/write, fingerprint conflict, exact retry, removal,
  cancellation and late-write refusal. No owner chat is submitted or interrupted.
- Inspector code travels over SSH per request. No persistent Scheduled Task or
  Companion/helper contract changes; setup omits the profile from its existing
  helper payload. The Hub release therefore supplies the Windows-side change.

Physical iPhone/iPad acceptance remains pending owner use. Profile instructions
are guidance for future requests, not evidence that every model will obey them.
