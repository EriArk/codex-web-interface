# Vision

## Purpose

Codex Web Interface is a **private personal work platform** centered around Codex.

The user should be able to sit with a 13-inch iPad, open a project, tell Codex what to change, see the useful outputs in a separate visual feed, and only open Remote Desktop when hands-on inspection is actually needed.

The system should remove the need to remote into a full desktop for ordinary development tasks.

## Primary user story

> I open Case Maker on my iPad, continue a Codex thread running on my Windows PC, ask for a change, watch the response stream, inspect screenshots/builds/diffs on the right, and only switch that pane to Remote if I want to poke the real app manually.

The same UI should work when Codex runs locally on the Linux server.

## Product principles

### 1. Project-first, not machine-first

The user thinks in terms of `Case Maker`, `AltarProject`, `Reader`, etc. The selected project determines which machine and working directory the Hub uses.

Machines should be visible when useful, but they are not the main navigation model.

### 2. Conversation and output are different things

The center pane is a clean human/Codex conversation.

Screenshots, builds, artifacts, diffs and logs should not bury the chat. Useful outputs belong in the right-side Results feed; verbose technical detail belongs in Activity.

### 3. Remote Desktop is a fallback, not the product

The desired workflow is mostly:

```text
ask -> Codex works -> inspect result -> refine
```

Remote exists for the moments where direct interaction is faster than explaining.

### 4. The Windows PC stays a normal PC

The primary Windows machine is not turned into a public server.

It does not need a public domain, port forwarding, a public Codex listener or a custom web server. The Linux Hub reaches it over the trusted LAN using normal machine-management protocols.

### 5. The Hub owns the web experience

The Linux Hub provides:

- authentication;
- PWA frontend;
- project/machine metadata;
- Codex transport/adaptation;
- result history;
- Remote Desktop bridge;
- future notes/plans/status modules.

Execution stays on the machine where the project and toolchain live.

### 6. Grow gradually into a personal platform

The initial product is deliberately narrow. The architecture should allow later modules without turning v1 into a giant dashboard.

Potential modules:

- Notes;
- Plan / tasks;
- pinned project context;
- machine status;
- Files;
- Git summaries;
- activity history;
- preview/artifact library;
- additional execution machines over Tailscale;
- optional interactive Windows companion.

## Experience target

The target feeling is closer to a **dedicated control console** than an IDE or SaaS dashboard.

The user should be able to understand the state of a project at a glance:

- what thread is active;
- what Codex is doing;
- what changed;
- whether the build worked;
- what the latest visual result looks like;
- whether the execution machine is online;
- what to do next.

## Visual identity

The functional layout is stable, but the product supports strong visual skins:

- digital organizer;
- green CRT terminal;
- high-end early-2000s device/workstation.

These themes should feel materially different while preserving the same information architecture and interaction model.

## Non-goals for v1

Do not build these before the main flow works:

- a browser replacement for VS Code;
- a full file editor;
- a general multi-user collaboration platform;
- public account registration;
- cloud-hosted execution;
- arbitrary machine orchestration;
- a custom SSH implementation;
- a custom Remote Desktop protocol;
- perfect import of all historic Codex threads;
- automatic control of the visible Windows GUI from the SSH session.

## Long-term success condition

The project succeeds when the user can do most routine work on several personal projects from the iPad without feeling that they are using a compromised remote desktop session.
