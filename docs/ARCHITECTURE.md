# Architecture

## Overview

CodexWeb is an authenticated Project-first workspace running on a Linux Hub. The Hub coordinates private user runtimes, native Codex execution, consumer GPT integration, durable Results/workspace state, collaboration metadata and Remote/GUI access without exposing the execution machines directly to the Internet.

For the concise current-status map, see [CURRENT_STATE.md](CURRENT_STATE.md). Exact deployment/acceptance claims belong in [ROADMAP.md](ROADMAP.md), [VERIFICATION.md](VERIFICATION.md) and [RELEASES.md](RELEASES.md); current source must not be treated as automatically installed.

The public service is split into a replaceable web/API gateway and a persistent execution engine. The persistent side owns authenticated runtime selection, native sessions, SQLite, queues, GPT orchestration, private PTYs, collaboration services and durable receipts over private host IPC. A web/gateway update does not imply replacement of a running native execution session.

At a high level:

```text
Browser / PWA
    |
    | HTTPS / WebSocket
    v
+-----------------------------+
| Linux Hub                   |
|                             |
| Auth / principal resolution |
| Project + workspace state   |
| Codex session orchestration |
| GPT private bindings        |
| Results / Files / Review    |
| Collaboration Spaces        |
| Remote / device gateways    |
| Receipts / recovery / DB    |
+-------------+---------------+
              |
      private transports / IPC
              |
    +---------+-----------------------------+
    |                                       |
    v                                       v
User execution machine/runtime       Hub-local/private runtime
Codex + Git + toolchain              Codex/GPT helpers as configured
project checkout                     private user state
Companion where required
```

Only the Hub is Internet-facing. Execution machines remain reachable from the Hub over trusted LAN/Tailnet/local transport and keep their own project files, toolchains and native account material.

### Personal runtime boundary

Every private API resolves an authenticated principal before selecting runtime services. Each user owns a scoped personal runtime containing their Store/artifacts, project/checkouts, machine bindings, native Codex sessions, GPT connector/profile and background work.

Never fall back to the first configured owner, machine or GPT profile when principal resolution fails.

Private SQLite/artifact namespaces keep native IDs, drafts, chats, terminals, Remote tickets and generated data separate. Admin/installation authority does not imply private-content access.

### Collaboration boundary

[Collaboration Spaces](COLLABORATION_SPACES.md) is the current user-facing shared-work model. A Space relates real personal Projects; it does not create a synthetic replacement code project.

For every participant:

- their checkout/path/native thread IDs remain private to their runtime;
- access to each Project is explicit and asymmetric;
- shared metadata never grants another user's private Codex/GPT transcript or machine access;
- Git/GitHub actions run under the acting user's authorized identity and current agreement;
- membership removal removes collaboration metadata/context rather than deleting a participant's local repository/history.

The shared installation registry stores only the metadata required to establish users, membership, invitations, Project relationships, grants, shared chat and other explicit collaboration records. Cross-user reads/actions must re-check current authorization at the actual operation boundary.

### Durable work and unknown outcomes

Long-lived operations bind the initiator, exact Project/checkout/thread/object identity, revision and receipt. Authorization is rechecked before dispatch/mutation/publication where applicable.

Unknown mutation outcomes are reconciled before retry. Browser reconnect, Hub restart or duplicate clicks must not cause blind replays of native sends, GitHub writes or other irreversible work.

## Trust boundaries

### Public zone

Only the Hub's HTTPS endpoint is public.

### Trusted machine zone

Configured execution machines are reachable only from the Hub over trusted LAN/Tailnet/local transport. Their SSH and Remote ports should be firewall-restricted to the Hub identity/address where applicable.

### Browser boundary

The browser never receives SSH credentials, RDP credentials, Codex auth data or direct App Server access.

## Main components

### `apps/web`

Responsive React PWA for phone, tablet and desktop.

Responsibilities:

- authentication UI;
- project/thread navigation;
- Codex chat;
- approval dialogs;
- Results/Files/Activity/Remote pane;
- Notes/Tasks/Plans/Reports/Core, project review/delivery and device workspaces;
- theme rendering;
- reconnect/resume UX.

It communicates only with the Hub.

### `apps/hub`

Fastify-based server.

Responsibilities:

- login/session management;
- project and machine registry;
- browser WebSocket/event sessions;
- Codex session ownership;
- machine transport orchestration;
- protocol normalization;
- result persistence/indexing;
- Remote Desktop authorization/proxy integration;
- notes/tasks/project-work/device APIs;
- scoped personal runtimes and collaboration-space APIs with explicit authorization boundaries.

### `packages/machines`

Machine transport abstraction.

Suggested interface shape:

```ts
interface MachineTransport {
  id: string;
  kind: 'local' | 'ssh-windows' | 'ssh-linux';
  checkHealth(): Promise<MachineHealth>;
  spawn(command: CommandSpec): Promise<ManagedProcess>;
  run(command: CommandSpec): Promise<CommandResult>;
}
```

Core implementations:

- `LocalMachineTransport`
- `SshWindowsTransport`

A dedicated remote SSH-Linux transport remains a separate extension:

- `SshLinuxTransport`
- Tailnet-backed hosts use the same SSH transport with a different address.

### `packages/codex`

Compatibility layer around Codex App Server.

Responsibilities:

- launch/initialize App Server;
- JSONL framing over stdio;
- request/response correlation;
- event parsing;
- thread start/resume/list operations used by the app;
- approvals and interrupts;
- normalization into stable Hub events;
- version/capability detection;
- graceful shutdown.

The rest of the application should not depend on raw App Server JSON schemas.

### Result store

Metadata in SQLite, artifact bytes on disk.

Example:

```text
data/
  app.db
  results/
    <project-id>/
      <thread-id>/
        <turn-id>/
          screenshot.webp
          preview.png
          artifact.step
```

Paths are illustrative. Actual storage should use opaque/internal IDs and safe filenames.

### Remote gateway

Use Apache Guacamole/`guacd` as the protocol bridge instead of implementing RDP/VNC.

Hub controls whether a browser session may establish the connection and supplies server-side connection parameters.

## Project model

A Project is the primary user-facing work unit. In a personal runtime it binds the exact repository/working root, execution machine/runtime, native Codex context and workspace state needed for that user.

Machine paths and native thread IDs are personal-runtime data. Collaboration refers to a participant's own Project/checkout binding rather than copying another participant's path or thread identity into shared metadata.

In shared work, keep these concepts distinct:

```text
Project identity / repository
        |
        +-- owner / collaboration metadata
        |
        +-- User A personal checkout + Codex/GPT context
        |
        +-- User B personal checkout + Codex/GPT context
```

The same repository may therefore have different machine/root/thread bindings for different users while still remaining one exact GitHub repository identity. Collaboration policy can narrow actions; it cannot grant authority beyond the acting user's real repository/runtime permissions.

## Thread model

The Hub stores a mapping between a project and the Codex thread identifier plus display metadata.

```ts
interface ProjectThread {
  id: string;            // Hub id
  projectId: string;
  codexThreadId: string;
  title?: string;
  createdAt: string;
  lastActivityAt: string;
  archived: boolean;
}
```

The Hub stores durable mappings/cached metadata while native Codex remains authoritative for native thread data. Discovery/import of external native history is bounded and must not turn Hub storage into an uncontrolled duplicate of the native database.

## Codex session lifecycle

### Remote Windows

```text
1. Browser opens project/thread.
2. Hub resolves Project -> Machine + cwd.
3. SessionManager checks for an existing live Codex process.
4. If none exists, SshWindowsTransport starts a remote process.
5. Remote command starts Codex App Server over stdio.
6. Hub initializes App Server and resumes/starts the thread.
7. Browser subscribes to normalized Hub events.
8. Browser may disconnect; Hub keeps the session/turn alive.
9. Reconnected browser requests current state and resumes events.
10. Idle sessions are closed according to policy when no turn is active.
```

### Local Linux

Same lifecycle, but process spawn is local instead of SSH.

## SSH transport

Use the host system's OpenSSH client.

Reasons:

- existing `~/.ssh/config` support;
- standard key/known-host handling;
- easy manual debugging;
- mature connection multiplexing;
- less custom security-critical code.

The Hub should support an SSH host alias as configuration, e.g. `main-windows`, rather than forcing host/user/key fields into application code.

On the Hub, connection reuse can use normal OpenSSH multiplexing/`ControlPersist` where supported/configured.

## Windows-specific launch path

Do not assume a Unix shell.

Remote launcher should:

1. invoke a known Windows shell intentionally (`powershell.exe`/`pwsh.exe` or `cmd.exe`);
2. set the target working directory safely;
3. resolve the Codex executable robustly;
4. support npm `.cmd` shims as well as native `codex.exe`;
5. preserve stdout for App Server protocol only;
6. route shell/App Server diagnostics to stderr/Hub logs.

The exact launch wrapper belongs in `packages/machines`/`packages/codex`, not scattered through application code.

## Browser event contract

Use an internal event model. Example categories:

```text
session.state
thread.created
thread.updated
turn.started
turn.completed
assistant.delta
assistant.completed
approval.requested
approval.resolved
tool.started
tool.completed
files.changed
result.created
machine.health
error
```

Do not guarantee that these names match Codex protocol names.

The adapter is free to translate multiple App Server versions into this stable contract.

## Result normalization

Useful structured outputs should become separate Result records.

Suggested result types:

```text
image
artifact
preview
build
check
diff-summary
error
text/document where promoted from a public artifact source
```

Each Result should reference:

- project;
- Hub thread;
- Codex turn where possible;
- timestamp;
- source/provider;
- artifact path/URL or structured payload.

## Persistence

SQLite is the authority for Hub-owned metadata/state. Artifact/file bytes that do not belong in SQLite live in private filesystem stores referenced by opaque IDs.

Current Hub-owned state includes authentication/sessions, per-user runtime/project mappings, native thread mappings, Results/artifact metadata, preferences, Notes/Tasks/Plans/Reports/Core/Review/Delivery state, durable queues/receipts, GPT bindings/cache metadata and explicit collaboration records.

Personal namespaces and shared installation/collaboration records remain logically separate so backup/restore/revocation can preserve ownership boundaries.

Codex source-of-truth native thread data remains Codex-owned; the Hub stores exact mappings and bounded useful cached/projection data rather than treating its database as a second complete native Codex database.

## Machine health

Machine health is auxiliary.

The Hub may run lightweight bounded health checks over the configured transport and cache the result. Avoid constant high-frequency polling and do not put machine/native reads on unrelated UI critical paths.

Possible fields:

- online/offline;
- last seen;
- Codex available/version;
- disk space;
- memory/CPU summary;
- Remote provider available.

Temperature/GPU data is optional and hardware-dependent.

## Windows Companion

A logged-in Windows desktop session is separated from OpenSSH Session 0. The installed/approved Companion handles the interactive-session boundary needed by native Codex/runtime behavior on Windows.

Constraints remain intentionally narrow:

- runs in the logged-in user's session;
- exposes local IPC (named pipe) rather than a public TCP listener;
- can be reached only through the authenticated/configured machine path;
- is not a browser-supplied arbitrary command endpoint;
- ordinary authorization and exact Project/machine binding still happen at the Hub.

The Companion is infrastructure for the private execution machine, not a second public CodexWeb server.

## Failure handling

The Hub must explicitly represent:

- target machine offline;
- SSH authentication/host-key failure;
- Codex executable missing;
- App Server exits/crashes;
- malformed/unsupported protocol message;
- thread resume failure;
- Remote provider unavailable;
- browser disconnect;
- turn cancellation timeout.

A failure on one project/machine must not crash the Hub.

## Technical references

- OpenAI Codex repository / App Server implementation: https://github.com/openai/codex
- Microsoft OpenSSH for Windows: https://learn.microsoft.com/windows-server/administration/openssh/openssh_install_firstuse
- Microsoft interactive process/session guidance: https://learn.microsoft.com/windows/win32/services/interactive-services
- Apache Guacamole: https://guacamole.apache.org/

## Implemented release notes (2026-09-06)

The first release uses the proposed TypeScript workspace, Fastify, React, SQLite and filesystem storage. Deployment is a Hub container plus guacd and an independent Cloudflare tunnel. See DEPLOYMENT.md for the actual bindings and state locations.

The owner-approved early Companion (D17) resolves the observed Windows Session 0 sandbox failure through local named-pipe IPC. The public and machine boundaries remain unchanged. HTTP file uploads terminate at the Hub and are staged on Windows through SSH only when a turn is sent.

SQLite owns settings, messages aggregated from events, cursor-based history, thread mappings, sessions, idempotency keys and attachment metadata. Remote sessions are manual and independent from the Hub's long-lived Codex runtimes. The UI implements one mobile/wide component tree with shared theme tokens.


### Native GPT integration boundary (historical checkpoint, 2026-09-19)

This dated subsection records the transition design. Native per-user GPT runtime integration is now used beyond the state described in its final sentence; current behavior/status belongs in [CURRENT_STATE.md](CURRENT_STATE.md), [GPT_NATIVE_LINUX.md](GPT_NATIVE_LINUX.md) and deployment evidence.

The shared GptService can receive a private NativeGptWorkspace dependency for isolated integration admission. Typed owner-bound Unix-socket operations supply public reads and the existing gpt_jobs worker; no browser-supplied socket, native method or account identity is accepted. Each durable outbox entry records its provider, and transport changes never migrate/replay queued or uncertain sends. Legacy and native cache/transport paths remain separate, with unsupported native features failing explicitly instead of falling back to the old account. The production runtime does not yet supply this dependency; parity, explicit unknown-send review and per-member binding are release gates tracked in GPT_NATIVE_LINUX.md.
