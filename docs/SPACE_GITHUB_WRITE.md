# GitHub Write in Shared Spaces

The owner confirmed Write (not Admin) for «Полный доступ» on 23 September 2026. This extends the previous local `direct` collaboration mode through the existing machine-local GitHub transport.

Choosing direct access in creation, participant invitation, project addition, reciprocal acceptance or project settings durably records an owner-authorized grant in the same SQLite transaction as the Space metadata. The background outbox uses the owner's private project copy and GitHub account. Collaborate mode does not grant GitHub access.

The participant connects their own GitHub account once: select their own registered computer, inspect its authenticated GitHub account, then confirm the displayed login and numeric ID. No personal project or checkout is required, so the first private repository can be accepted before cloning. Existing project-bound confirmations remain compatible. The record contains a private account/machine binding; other participants see only the public login and operation state. New identity confirmation wakes grants waiting for that user. A missing account or unavailable machine never falls back to the owner's identity.

The worker raises read/triage to Write and upgrades a pending read invitation, preserving Write/Maintain/Admin. GitHub may require an invitation to be accepted. The recipient uses «Принять Write» in the invitation or Space settings, through their own machine account. The fixed helper verifies the invitation's exact repository ID/name and invitee numeric ID before acceptance. No site navigation or credentials on Hub are required.

Every external action has a persisted machine receipt and exact account, repository and checkout binding. Lost acknowledgements and restart resume the same receipt; uncertain writes are read back rather than issued again. Current membership, execution epochs and direct grant are checked immediately before dispatch. Removed/rebound contexts cannot authorize a new mutation. Active and uncertain operations participate in engine maintenance admission.

Existing direct grants are not retroactively dispatched on startup or catalog reads: the project owner uses «Проверить доступ» to synchronize them. Local downgrade/removal does not silently remove GitHub rights; use the existing explicit repository collaborator removal action for that separate operation.

Verification: focused GitHub worker, Space lifecycle and legacy Team GitHub tests cover role elevation, recipient identity substitution, internal acceptance, lost acknowledgements, restart, policy changes and cross-user denial. Chromium/WebKit cover the complete two-account flow and four-theme phone, constrained phone and tablet layouts. Installed Windows `delivery/githubWorkProbe.js` must match the compiled release and pass a read-only Hub → SSH → Scheduled Task probe. Real invitation side effects are fixture-only; personal device/member-PC acceptance remains deferred.


## First working copy

A single-project invitation, project overview and existing-copy settings launch the same project setup with the exact shared repository. GitHub selection stays fixed for this clone; machine, name and destination remain editable. The nested setup preserves its parent and restores its draft/operation in a separate account-local source scope. Ordinary project drafts and unrelated pending operations cannot be silently reused for a shared copy. Closing and reopening resumes the same setup; late completion cannot redirect a different active window.

The fixed Windows delivery worker accepts `root: null` only for the typed GitHub helper. In this mode the helper uses its own OS home internally, permits only authenticated identity inspection and exact recipient invitation acceptance, and refuses repository writes. Receipt scope distinguishes account-only and checkout-bound work. Both `DeliveryWorker.cjs` and `githubWorkProbe.js` must be upgraded together while the installed Scheduled Task is idle. No port, generic command, login token transfer or new GitHub authorization method is added; the computer uses its existing private GitHub CLI login.

Automated acceptance includes a member with zero projects: settings elevation → machine identity confirmation → internal Write acceptance → exact clone → native project registration → invitation binding. It also checks close/reopen recovery, unrelated draft preservation, account substitution, forbidden account-only writes, and all four themes in Chromium/WebKit. Windows production probes are read-only; actual permission mutations use fixtures.
