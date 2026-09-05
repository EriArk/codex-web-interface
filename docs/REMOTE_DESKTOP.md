# Remote Desktop

## Role in the product

Remote Desktop is an **occasional manual-control mode** inside the project workspace.

The normal workflow should remain Codex + Results. Remote is opened when the user wants to inspect or interact with the real Windows desktop/app directly.

## Preferred architecture

```text
Browser
  -> authenticated Hub session
    -> Guacamole client integration
      -> guacd on Linux Hub/network
        -> trusted LAN
          -> Windows Remote Desktop provider
```

The Windows machine is never connected to directly by the browser and its Remote port is never exposed publicly.

## Provider abstraction

Do not hard-code the whole feature to one Windows edition.

Suggested interface:

```ts
interface RemoteProvider {
  kind: 'rdp' | 'vnc' | string;
  checkAvailable(machine: Machine): Promise<RemoteAvailability>;
  createSession(input: RemoteSessionInput): Promise<RemoteSessionDescriptor>;
  closeSession(id: string): Promise<void>;
}
```

Initial providers can both use Guacamole:

- RDP when the target Windows edition supports hosting Remote Desktop;
- VNC-compatible fallback when it does not.

The provider choice is machine configuration.

## Why Guacamole

Use Apache Guacamole/`guacd` rather than writing RDP/VNC/WebRTC desktop streaming from scratch.

The web app can integrate Guacamole's browser client while keeping our own surrounding UI, authentication and project model.

## Network policy

For a LAN Windows machine:

- allow RDP/VNC only from the Linux Hub's address;
- do not forward the port through the router;
- do not publish the provider through Cloudflare or another public tunnel directly;
- browser access must be gated by Hub authentication.

## UI behavior on 13-inch iPad

Default workspace:

```text
Navigation | Chat | Results
```

When Remote is selected:

```text
Navigation | Chat | Remote
```

Remote can expand:

```text
+---------------------------------------+
|              Windows                  |
|                                       |
|          Remote Desktop               |
|                                       |
+---------------------------------------+
| Back to Codex     Keyboard     Mode   |
+---------------------------------------+
```

Returning from fullscreen Remote must preserve:

- active project;
- active thread;
- chat scroll/state;
- Results scroll position;
- running Codex turn.

## iPad input modes

Provide at least two interaction modes if the selected Guacamole integration allows it cleanly:

### Direct touch

Tap maps to the remote position.

Useful for simple application UIs.

### Trackpad

The remote surface behaves like a large trackpad:

- one-finger motion moves pointer;
- tap clicks;
- two-finger gesture scrolls;
- right-click gesture/menu is available.

This is more useful for desktop apps, CAD and fine pointer work.

## Remote toolbar

Touch-friendly toolbar should expose difficult desktop keys/actions without requiring a physical keyboard:

- show/hide keyboard;
- Esc;
- Ctrl;
- Alt;
- Windows key;
- Ctrl+Alt+Del equivalent if supported safely by provider;
- fullscreen/restore;
- input mode;
- disconnect.

Do not make the controls tiny or hover-only.

## Resolution

Remote resolution should adapt to the available pane/fullscreen size where the protocol/provider supports it.

Do not require the Windows desktop to run at the iPad's native pixel resolution. Prefer a sensible logical resolution and readable scaling.

## Session behavior

Remote sessions are separate from Codex App Server sessions.

Closing Remote should not:

- interrupt Codex;
- archive the thread;
- kill project state.

Likewise, a Codex restart should not automatically disconnect an active Remote session unless required by deployment.

## Credentials

Remote credentials are server-side secrets.

Rules:

- never send raw RDP/VNC password to browser JavaScript if Guacamole integration can avoid it;
- never store credentials in Git;
- prefer OS/deployment secret storage or encrypted Hub secret storage with filesystem permissions;
- redact credentials from logs and connection URIs.

## Windows session caveat

Do not assume the Remote session and SSH session are the same Windows session.

This matters because GUI processes started by Codex under OpenSSH may not appear in the visible Remote desktop.

For v1, the intended usage is:

1. Codex edits/builds through SSH;
2. user opens Remote when manual GUI testing is needed;
3. user launches/tests the app interactively if necessary.

A future Windows Companion can close this gap without exposing the PC publicly.

## Future enhancements

Possible later improvements:

- one-button launch of a configured project's GUI app in the interactive session;
- capture a screenshot from the interactive desktop into Results;
- clipboard helpers;
- file handoff between Results and remote machine;
- project-specific Remote resolution profiles;
- reconnect to an existing desktop session;
- optional low-latency streaming provider if RDP/VNC becomes inadequate.

These are post-MVP.

## Reference

- Apache Guacamole documentation: https://guacamole.apache.org/doc/gug/
