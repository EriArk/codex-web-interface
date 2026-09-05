# Codex Integration

## Goal

Use Codex App Server as the execution interface while keeping the frontend insulated from App Server protocol churn.

The primary v1 path is:

```text
Hub (Linux)
  -> system ssh
    -> Windows shell
      -> codex app-server (stdio)
```

The local Linux path is the same adapter around a local child process.

## Why App Server instead of terminal scraping

Do not build the product around a pseudo-terminal/TUI scraper unless App Server proves unusable for a required capability.

App Server provides structured concepts such as threads, turns, events and approvals. This is the correct foundation for a native web UI.

## Adapter boundary

Only `packages/codex` should understand raw App Server messages.

Suggested public interface:

```ts
interface CodexSession {
  initialize(): Promise<CodexCapabilities>;
  listThreads(options?: ThreadListOptions): Promise<ThreadSummary[]>;
  startThread(input: StartThreadInput): Promise<ThreadHandle>;
  resumeThread(codexThreadId: string): Promise<ThreadHandle>;
  startTurn(input: StartTurnInput): Promise<TurnHandle>;
  interruptTurn(turnId: string): Promise<void>;
  resolveApproval(id: string, decision: ApprovalDecision): Promise<void>;
  subscribe(listener: (event: HubCodexEvent) => void): Unsubscribe;
  close(): Promise<void>;
}
```

Do not force the exact interface above if the actual protocol makes a slightly different shape cleaner. Preserve the boundary and behavior.

## Transport framing

For stdio transport:

- stdin/stdout carry protocol messages;
- implement incremental line buffering;
- handle partial chunks and multiple messages per chunk;
- define a maximum tolerated message size;
- reject malformed protocol lines cleanly;
- never mix Hub debug output into the child stdout stream.

Child stderr should be captured separately for diagnostics and surfaced in Activity/logs when useful.

## Windows executable resolution

Do not blindly do `spawn('codex')` from a Windows remote command.

Codex may be available as:

- native `codex.exe`;
- npm-generated `codex.cmd` shim;
- a user-specific executable directory not present in a non-interactive PATH.

Preferred resolution order:

1. explicit per-machine `codexCommand` configuration;
2. probe with `where.exe codex` in the target user's SSH environment;
3. choose a compatible returned executable/shim;
4. fail with a useful setup message including the remote PATH/probe result.

When invoking `.cmd`, use a Windows shell intentionally and quote arguments safely.

Avoid parsing human-localized shell output when a machine-readable alternative exists.

## Working directory

Each project has an absolute working directory in target-machine syntax.

The Hub must validate the project mapping before launch. The remote launcher should switch to that working directory before App Server/thread operations that depend on `cwd`.

Never apply POSIX path normalization to Windows paths.

## Authentication state

Codex runs under the existing target OS user so it can use that user's existing Codex configuration/authentication.

Do not:

- copy Codex tokens/auth files into the Hub database;
- send Codex credentials to the browser;
- commit Codex auth files into this repository.

If the SSH user's environment cannot see the user's Codex state, solve that as a machine setup/configuration issue rather than copying secrets into the web app.

## Session ownership

The Hub owns the process, not the browser tab.

Required behavior:

- closing/reloading Safari does not immediately terminate an active turn;
- a reconnecting browser can ask the Hub for current session/turn state;
- multiple tabs should not accidentally create duplicate App Servers for the same intended live session;
- explicit stop/interrupt must work;
- idle App Server sessions may be reaped only when no turn is active.

The exact pooling policy can start simple. Correctness matters more than maximizing reuse.

## Project/thread mapping

v1 behavior:

- user opens a Hub Project;
- threads started from this UI are recorded in `project_threads` with the Codex thread ID;
- Hub can resume those threads later;
- thread display title may come from Codex metadata or a Hub-maintained title;
- archive/hide state is Hub-owned UI metadata.

Do not block MVP on discovering every historical thread created in other Codex clients.

A later `Discover existing threads` flow can query App Server and offer unmatched threads for import.

## Streaming

Normalize streaming into stable Hub events.

The browser should be able to render:

- assistant text deltas;
- turn state;
- tool/activity state;
- approval requests;
- errors;
- result creation.

The frontend should not need to know request IDs or method names used by a specific App Server release.

## Approvals

Approval prompts are first-class UI events.

Requirements:

- show what action needs approval in human-readable form;
- clearly distinguish Allow/Deny;
- associate approval with project/thread/turn;
- do not auto-approve because the browser disconnected;
- reconnecting UI must recover pending approval state where possible.

Avoid placing approval buttons in the Results feed if that makes them easy to miss. A visible chat/turn-level prompt or modal/banner is acceptable.

## Tool/activity normalization

Detailed tool activity belongs in the Activity view.

Possible normalized activity entries:

```text
read-file
write-file
command
search
mcp
build/test command
unknown-tool
```

Do not promise a fixed set if App Server exposes richer/different tools. Unknown events should degrade gracefully instead of breaking the session.

## Results extraction

Create Result records from structured events where possible.

Examples:

- image item/event -> `image` result;
- generated file explicitly surfaced by Codex -> `artifact` result;
- file-change event -> `diff-summary` result;
- known build/test command outcome -> `build`/`check` result;
- explicit preview URL emitted by a project integration -> `preview` result.

Do not treat every shell command as a Result. Activity may contain hundreds of commands; Results should be curated/useful.

## Windows GUI-session limitation

A Codex App Server launched under Windows OpenSSH is not a reliable route to the visible interactive desktop.

Therefore v1 should separate:

### Supported confidently over SSH

- source editing;
- Git operations;
- CLI builds/tests;
- headless tooling;
- generated files/images;
- project-specific CLI previews.

### Not assumed in v1

- launching a desktop GUI that appears in the user's current desktop;
- capturing arbitrary visible windows from the SSH process;
- automating the user's desktop from the SSH process.

For hands-on GUI inspection, use Remote Desktop. For automated GUI launch/capture later, use the optional interactive Windows Companion described in `ARCHITECTURE.md`.

## Compatibility strategy

Codex evolves quickly. Treat version tolerance as an explicit requirement.

At App Server startup:

1. initialize;
2. record server version/capabilities if exposed;
3. enable only features supported by that server;
4. log unknown notifications/events without crashing;
5. keep protocol-specific code centralized.

Prefer feature/capability detection over hard-coded version checks when possible.

## Diagnostics

Keep enough structured diagnostics to debug remote startup without exposing secrets.

Useful fields:

- machine ID;
- project ID;
- SSH exit code;
- selected Codex command/path;
- App Server version/capabilities;
- process start/exit timestamps;
- protocol parse errors;
- last stderr lines with secret redaction.

Do not log full auth files, environment dumps containing tokens, or remote passwords.

## Suggested first integration test

Before building most of the UI, prove this from the Hub:

1. connect to configured Windows host with system SSH;
2. run `where.exe codex`;
3. start App Server over stdio in one configured project directory;
4. complete protocol initialization;
5. start a disposable/new thread;
6. send a simple turn that reads a harmless project file;
7. stream the assistant response;
8. cleanly terminate the App Server.

Then wrap that exact proven path in the Hub abstractions.

## References

- OpenAI Codex repository: https://github.com/openai/codex
- Current App Server source/docs should be checked from the installed/current Codex version during implementation rather than copying protocol schemas permanently into app logic.

## Implemented compatibility boundary

The current implementation splits byte-level JSONL/RPC lifecycle (packages/codex), OS process and file transport (packages/machines), and Hub domain/event normalization (apps/hub/src/sessions.ts). No App Server payload is forwarded unchanged to the browser.

Initialize negotiates experimentalApi for collaborationMode/list. model/list and config/read supply model-specific effort choices and the Windows effective default; thread preferences live in SQLite. turn/start passes model, effort and collaborationMode.settings with developer_instructions set to null to use Codex's own selected-mode instructions. Native plan items are streamed and saved to Results. Text-only models reject image inputs visibly.

See D17 for the approved Session 0 workaround. The bridge uses raw inherited standard handles and explicit flushing for small JSONL frames; normal buffered Console stdin was insufficient under Windows SSH. The existing Windows Codex authentication stays on Windows. A browser disconnect leaves a Hub-owned turn running. A Hub process restart may stop the turn; unknown commands are never automatically repeated.
