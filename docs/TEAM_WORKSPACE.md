# Private team workspaces

Owner-approved specification, 2026-09-13. Tracking: [#159](https://github.com/EriArk/codex-web-interface/issues/159). This document describes the next implementation, not a claim that team access is already installed. [Roadmap](ROADMAP.md) records acceptance separately from development progress.

## Product and first acceptance

The current Linux Hub serves initially two trusted people, with a small-team design suitable for roughly 2–10. The friend first gets a complete private CodexWeb on their own Windows PC, their own Codex/consumer ChatGPT/GitHub accounts, and both desktop/mobile browsers. They can participate in physical acceptance. The server remains the current installation; a future server move is separate.

The same pass then provides both collaboration cases: one logical project with independent personal checkouts, and narrow links between independently owned private projects. No public signup, organizations, billing, MDM, shared AI credentials or mandatory common implementation chat.

## Decisions confirmed with the owner

| Area | Decision |
| --- | --- |
| First usable result | Friend uses their full private Codex/GPT workspace on the existing Hub |
| PC enrollment | Invitation → Windows script/master → diagnostics → admin verifies candidate |
| Folder scope | Owner selects allowed project roots during PC setup |
| Admin | Access/infrastructure metadata only; private content is not implicitly readable through the application |
| Device support delegation | Deferred; sharing a project never shares terminal/Remote |
| Existing project materials | Select explicitly when converting private project to shared |
| New shared-project records | Notes/Tasks/Plans/Reports created there are shared by default, visibly labelled |
| Personal history | Native chats, drafts, account usage and unpublished results remain personal |
| Automatic collaboration | Both sides opt in per link; bounded read-only consultations; implementation requires explicit target action |
| Bridge coordinator | Owner of the Bridge's chosen project, using that owner's Codex account/machine |
| Other participants | Each consulted project uses its own owner's authorized account/checkout |
| Planning records | Repository documentation plus existing GitHub issues; no duplicate application Plans |
| First-pass exclusions | Separate-Hub installer, full Canvas, global GPT-history search, extra native integrations, duplex voice, GitHub Actions |

## Ownership and runtime boundaries

The authenticated principal has a durable user ID, login, display name, admin/member role and active/disabled status. Sessions, invitations, machine enrollment, notifications and background receipts bind to the ID, not a display name. Login has no public account directory. Existing owner password/native IDs remain valid after migration.

Each personal runtime owns its configured machines, catalog, Store, native sessions, GPT service/cache/outbox, artifacts and transient state. Existing functional route implementations can be reused inside a user-bound runtime; identity must be resolved before dispatch. A new user must never receive the original owner's service instances, default machine, GPT connector or filesystem fallback. Account/profile failures remain local to that user. Public API URLs can remain stable; user identity comes from the authenticated session, never a caller-supplied user header.

Personal persistence may use separate private SQLite/artifact namespaces to make isolation structural. Preserve the original owner's existing database, file paths and native references rather than renumbering them. The installation registry and shared collaboration store own users, machine enrollment, memberships and deliberately published shared state. Every runtime/namespace has exactly one durable owner. Restore must refuse missing or contradictory ownership mappings.

All request handlers, source links, searches, downloads, previews, WebSockets, push subscriptions and long-lived device tickets enforce the same boundary. Copying a URL or guessing an ID cannot cross it. Background execution carries the original initiator, project, checkout, revision and receipt and rechecks current permission at dispatch/commit. Denied or unknown operations cannot fall back to the installation owner's identity.

Admin can manage membership, pairing, health and session recovery. That role does not open private chats, Files/Git or Remote. This is application authorization; the host administrator still controls the OS and storage. End-to-end encryption against the host administrator is not promised.

## Personal account and machine onboarding

An admin creates a short-lived, revocable, one-use login invitation. The invited person chooses their own credentials. User enrollment and machine enrollment use different tokens with distinct purposes. No email delivery infrastructure is required: the owner explicitly shares the generated link.

The Windows master checks privileges/platform, installs or repairs Tailscale/OpenSSH and the fixed local helpers, detects Codex/Git/GitHub readiness and reports each step. Credentials stay in their native stores; the user performs native account sign-in. Script reruns preserve unrelated SSH configuration, projects and account settings.

Tailscale only carries private Hub→PC connectivity. Use short-lived per-enrollment credentials when the Hub's Tailnet integration permits it; otherwise make manual Tailnet approval an explicit master step. Never distribute a permanent Tailnet key. The browser cannot submit an arbitrary SSH destination or shell payload.

Enrollment registers a candidate with owner, stable machine identity, observed pinned SSH fingerprint, helper versions and diagnostic status. The admin must approve the candidate before native execution becomes available. A changed host identity fails visibly and cannot replace an existing machine silently.

Allowed roots are explicitly configured on enrollment/repair. Enforce canonical OS containment for directory browsing, project setup, existing native discovery and file reads; handle sibling prefixes, case folding, traversal, UNC and reparse/symlink escapes. The root picker must not become an unrestricted remote root-edit API. A root boundary constrains the project file interface, not the OS authority of the owner's explicitly opened terminal.

Candidate implementation uses `MachineConfig.allowedProjectRoots`. Its absence is reserved for legacy owner configurations; enrolled machines must supply a non-empty list. Directory metadata checks may be shared briefly across catalog pages, while execution and file access revalidate the physical path independently. Runtime machine authorization is an in-memory capability bound by the personal app, never a caller-supplied JSON field. Closing or revoking that runtime does not expose the machine through an unscoped fallback.

The friend gets their own Devices/Remote, usage, dictation, speech preferences and notifications. The Hub's host terminal and original Windows machine are not included. GPT uses an independent private persistent browser profile and connector/writer/queue; it cannot reuse the owner's login as a fallback. Shared speech generation may reuse a worker, but generated audio is authorized per user.

## Logical projects and personal checkouts

A logical project has one owner, private/shared visibility and explicit Viewer/Collaborator members. An invitation becomes membership only on acceptance. Viewer reads the shared materials; Collaborator edits and executes work through their own checkout; Owner additionally controls membership and project policy. Installation admin is not implicitly a collaborator.

Owner clarification (2026-09-13): shared projects still have one person as owner. A future separate corporate GitHub will also remain under the installation owner's control; it is a place for common repositories, not a new organization/role hierarchy in CodexWeb. Repository hosting and the logical project's owner stay separate. No corporate account setup is required for this pass.

A checkout binds a user and logical project to one of that user's machines, a permitted root, verified repository identity, native project mapping and independent Current/Previous Chats. Start with one active checkout per user/project. Reuse the Project Setup flow for clone/connect. No source tree or native chat is copied from another participant. Git synchronizes code through explicit normal operations; offline or diverged checkouts remain independent.

When sharing an existing private project, a review step selects Core, Notes, Tasks, Plans, Reports and published evidence. Preserve unselected personal items. Newly created project Notes/Tasks/Plans/Reports are shared by default; the audience is explicit and personal capture remains available. Shared Results/Reviews contain selected frozen evidence, never an implicit grant to the complete source chat. Inaccessible source links say that the source is private while the published snapshot remains readable.

Writes carry author/editor/acting user and revision. Stable attribution survives account disablement. Tasks have an optional single assignee. Plan execution records user/checkout/source turn; detect duplicate active execution of the same exclusive item. Review acceptance is attributed metadata, not Git approval or permission to execute on another person's PC. Preserve drafts on conflict.

Private native GPT projects/chats remain personal. A GPT finding may be deliberately published into shared coordination without sharing that native project or its history. The initial implementation/Relay/coordinator execution path remains Codex.

## Links, Bridges and GitHub

A cross-user Link identifies two logical projects and requires both owners' acceptance. A proposer cannot enumerate the target person's private projects; the recipient selects/offers their target during acceptance. Purpose, direction and consultation/Bridge/automatic-forward permissions are explicit. Revocation prevents new dispatches and rechecks return delivery from already-running work.

Relay is bounded transport: it sends one authorized consultation to the designated target owner's checkout/Current Chat and returns a bounded answer. It does not grant source-chat access. Keep 1–10 rounds, early resolution, stop, per-link pending limits and no blind replay. A stopped/unknown exchange cannot restart itself under a new root to bypass its allowance. Work proposals prepare normal Plans and require the target participant's explicit execution.

A Bridge is durable coordination for one goal, with project owner, participants, linked projects, shared messages, handoffs, questions, decisions, Issues/PRs and active/waiting/needs-owner/resolved/stopped state. Choose its owning project at creation. That project's owner provides coordinator execution; changing ownership/coordinator requires an explicit idle transition and new owner's authorization. A participant cannot silently cause unlimited spending on the coordinator account.

Participants explicitly publish bounded findings from private chats/Reviews/Plans/Results. The Bridge may compare findings, consult through accepted Links and prepare targeted work. It cannot edit another checkout, widen a Link or start implementation automatically. Shared records persist when individual source access is removed.

GitHub account identity is verified on the acting user's machine. Repository access and CodexWeb membership are distinct states/actions. Typed operations support collaborator invitation/removal, bounded Issue list/search/create/link/comment/state, and PR coordination across checkouts. Reconcile uncertain external writes before retry. Never silently post under another person's account, mirror every Bridge message, force push or auto-merge. GitHub Actions are not required for this project.

## Revocation, recovery and operations

Implement revocation with the first identity foundation. Disabling a member invalidates login, subscriptions and device/download/action tickets, while preserving source data and uncertain-operation receipts. Project/Link revocation rechecks access both before dispatch and on return. Removing a user cannot silently orphan a shared project: transfer ownership or archive explicitly.

Access audit records actor/target/action/outcome/receipt/time, excluding private content and credentials. GitHub collaborator removal, machine unpairing and Tailnet/key cleanup are separate explicit decisions. Do not delete local repositories, native accounts or GPT profiles as a side effect of disablement.

Before team deployment, retain a separately named stable checkpoint containing verified Hub data/artifacts, selected private configuration, source bundle and immutable image versions. Preserve GPT profiles separately; a consistent profile archive requires stopping its browser after verifying no active work. Snapshot/restore acceptance covers all personal namespaces, shared records and owner mappings. Restoration revokes old sessions and keeps uncertain writes uncertain. Do not roll back over newer admitted work.

Gateway updates retain the existing independent publication path. Engine migration waits for all users' native work and active/unknown terminals; verified idle shells may be replaced under the owner's existing policy. Resources and fault handling must prevent one person's disconnected or busy machine from breaking the other's personal workspace.

## Acceptance

1. Restore the stable snapshot into an isolated directory; validate IDs, files, credentials and unknown receipts without contacting native writers.
2. Migrate copied real state; test two users against every route/event/download capability and direct-ID attempts.
3. Verify independent native sessions, simultaneous activity, correct accounts, reconnect, crash recovery and isolated offline failures.
4. Verify two checkouts, publication audiences, current-chat rotation, edit conflicts, Plan collision and correct GitHub authorship.
5. Verify Link acceptance privacy, Relay limits/stop, Bridge ownership, revocation during a turn and no unauthorized late return.
6. Rehearse backup/restore and disable/re-enable, including stale WebSocket, terminal, Remote and artifact tickets.
7. Run Linux builds and meaningful backend/Chromium/WebKit checks, then the friend's real Windows enrollment and two-user workflows on desktop/mobile. Record actual hardware evidence separately.

Implementation, installed version and real acceptance are distinct statuses. A daily completion target does not mark an unchecked stage complete.
