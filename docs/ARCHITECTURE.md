# Architecture

## Overview

Codex Web Interface is a single-user web Hub with pluggable execution backends.

```text
                                  Internet
                                     |
                              HTTPS / WebSocket
                                     |
                           +---------v---------+
                           |     Linux Hub     |
                           |                   |
                           | Auth              |
                           | Project registry  |
                           | Session manager   |
                           | Codex adapter     |
                           | Result store      |
                           | Remote gateway    |
                           | SQLite            |
                           +----+---------+----+
                                |         |
                        local   |         | trusted LAN
                                |         |
                 +--------------+         +------------------+
                 |                                           |
        +--------v---------+                        +--------v---------+
        | Local Linux      |                        | Native Windows   |
        | project/backend  |                        | primary v1       |
        |                  |                        |                  |
        | codex app-server |                        | OpenSSH Server   |
        | --stdio          |                        | Codex            |
        +------------------+                        | projects/tools   |
                                                    | RDP/VNC host     |
                                                    +------------------+
```

## Trust boundaries

### Public zone

Only the Hub's HTTPS endpoint is public.

### Trusted machine zone

Windows and future execution machines are reachable only from the Hub over LAN/Tailnet. Their SSH and Remote ports should be firewall-restricted to the Hub address.

### Browser boundary

The browser never receives SSH credentials, RDP credentials, Codex auth data or direct App Server access.

## Main components

### `apps/web`

React PWA optimized for a 13-inch iPad.

Responsibilities:

- authentication UI;
- project/thread navigation;
- Codex chat;
- approval dialogs;
- Results/Files/Activity/Remote pane;
- Notes/Plan/Machines later;
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
- future notes/tasks/machine status APIs.

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

Initial implementations:

- `LocalMachineTransport`
- `SshWindowsTransport`

Future:

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

A project is a Hub-owned record:

```ts
interface Project {
  id: string;
  name: string;
  machineId: string;
  workingDirectory: string;
  enabled: boolean;
}
```

The working directory is interpreted by the target machine, so Windows paths stay Windows paths.

Examples:

```text
Case Maker
  machine: main-windows
  cwd: C:\Users\...\CaseMaker

AltarProject
  machine: hub-local
  cwd: /srv/projects/AltarProject
```

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

v1 only needs reliable threads created/imported through this web app. Perfect discovery of unrelated historical Codex threads is a later feature.

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
note (future/manual)
```

Each Result should reference:

- project;
- Hub thread;
- Codex turn where possible;
- timestamp;
- source/provider;
- artifact path/URL or structured payload.

## Persistence

SQLite is the authority for Hub-owned data.

Initial tables likely include:

```text
users
sessions
machines
projects
project_threads
results
ui_preferences
```

Later:

```text
notes
tasks
pins
activity_events
```

Codex source-of-truth thread data remains Codex-owned; the Hub stores mappings and useful cached metadata, not a second complete copy of the Codex database.

## Machine health

Machine health is auxiliary.

For v1, the Hub may periodically run lightweight commands over SSH and cache the result. Avoid constant high-frequency polling.

Possible fields:

- online/offline;
- last seen;
- Codex available/version;
- disk space;
- memory/CPU summary;
- Remote provider available.

Temperature/GPU data is optional and hardware-dependent.

## Optional future Windows Companion

There is a real Windows session boundary between OpenSSH processes and the logged-in GUI desktop.

If later features require:

- launch a GUI app visibly;
- capture the interactive desktop/window;
- enumerate visible windows;
- drive UI automation;

add a minimal **Windows Companion** that runs in the logged-in user's session.

Preferred constraints:

- starts at user login, not as a public service;
- no TCP listener;
- local IPC only (e.g. named pipe with restrictive ACL);
- a small command-line bridge invoked through SSH may relay requests to it;
- scope it specifically to interactive-session operations.

Do not make the Companion mandatory for ordinary Codex chat/edit/build workflows.

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
