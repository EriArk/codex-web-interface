# Vision

## Purpose

CodexWeb is a **private AI-development workspace** centered on Projects.

The goal is not to recreate an IDE in a browser. The goal is to let a person open a Project from phone, tablet or desktop, continue the correct native Codex/GPT context, understand what is happening, inspect durable outputs, work with collaborators safely and reach Remote/Desktop tools only when direct hands-on interaction is actually useful.

The same product model should work whether execution happens on a Windows workstation, the Linux Hub or another explicitly configured private machine/runtime.

## Primary user story

> I open a Project, continue its current Codex work, ask for a change, watch progress, inspect the resulting files/images/diffs/checks beside the conversation, discuss architecture or another developer's work with my private Project GPT, and only open Remote when I actually need to poke the real GUI.

For collaboration:

> Another participant keeps their own machine, checkout, Codex/GPT identity and private chats. We share a Collaboration Space, explicit Project access agreements, human chat and GitHub engineering state without merging our private runtimes into one account.

## Product principles

### 1. Project-first, not machine-first

The user thinks in Projects such as `Case Maker`, `AltarProject` or `Reader`.

A Project determines the relevant repository, checkout, machine/runtime, Codex context, Project Core and collaboration context. Machines are visible when useful, but they are infrastructure beneath the Project rather than the primary navigation model.

### 2. AI roles remain distinct

Codex is the implementation/work agent.

Project GPT is the user's private project companion for discussion, architecture, analysis and steering. It may receive bounded project/collaboration context, but it is not a silent mutation authority and it does not become a shared transcript merely because a Project is collaborative.

Human collaboration remains human collaboration. Space chat must not become a dump of native AI/tool events.

### 3. Conversation and durable output are different things

The conversation should stay readable.

Screenshots, generated files, long text/code blocks, builds, checks, diffs and other useful evidence belong in Results or their specialized viewers while preserving exact source links back to the message/turn that produced them.

Verbose execution detail belongs in Activity/native work surfaces rather than burying the human conversation.

### 4. Remote Desktop is a fallback, not the product

The desired loop is mostly:

```text
ask → AI works → inspect durable result → refine
```

Remote exists for the moments where direct interaction with the real application is faster than explaining or where visual/manual acceptance is required.

### 5. Private runtimes stay private

The Hub may host multiple users, but collaboration does not collapse them into one workspace.

Each user keeps their own:

- authenticated principal;
- Store/artifacts and private workspace data;
- machine bindings/checkouts;
- Codex/native sessions;
- GPT profile/bindings;
- drafts/background work;
- private terminals/Remote permissions.

Shared membership or a copied link never becomes authority to inspect another user's private runtime.

### 6. Collaboration is an overlay on real Projects

A Collaboration Space groups real Projects and people; it is not a synthetic replacement code project.

GitHub remains the durable engineering truth for repositories, branches, commits, Issues, PRs and Reviews.

Access is explicit per Project × participant. The Project owner controls their authoritative state; collaborators use their own checkout/integration path and the rights actually granted to them. CodexWeb may narrow real GitHub capability but must never invent authority that the acting user does not have.

Leaving a Space or removing a Project must remove collaboration metadata/context without deleting a person's local repository, native history or private AI work.

### 7. The Hub owns the web experience, not the user's secrets

The Linux Hub provides authenticated workspace orchestration:

- PWA/web UI;
- private runtime selection;
- project/machine metadata;
- Codex transport/adaptation;
- GPT orchestration/bindings;
- Results/Files/Review/Delivery;
- collaboration metadata/chat;
- Remote gateway;
- persistence, receipts and recovery.

Execution, repository credentials and toolchains remain on the configured private runtime/machine where appropriate. The browser never receives SSH/RDP/Codex secrets or raw private runtime credentials.

### 8. Exact identity beats convenient guessing

CodexWeb should know which user, Project, checkout, repository, thread, Result and external object an action targets.

Do not resolve security- or mutation-sensitive actions from matching display names, filenames or stale prose when an exact identifier can be carried.

Unknown mutation outcomes are reconciled before retry; they are never blindly replayed.

### 9. Implement, verify, install and accept are different states

Source code existing is not proof that it is installed.

Automated browser/native-transport fixtures are not proof that a real second user, real GitHub permission or physical iPhone/iPad flow has been accepted.

Documentation, UI and status reporting should preserve those distinctions instead of compressing them into a single "done" state.

### 10. Grow by finished vertical slices

Prefer coherent, bounded passes that leave the product usable:

```text
contract / data / authorization
        ↓
service / transport
        ↓
UI / workflow
        ↓
verification
        ↓
guarded installation / real acceptance where required
```

Do not add a polished surface over a missing backend contract, and do not rebuild stable infrastructure merely because a newer UX hides it.

## Experience target

The target feeling remains closer to a **dedicated control console** than a generic SaaS dashboard or browser IDE.

A person should be able to understand the state of a Project at a glance:

- which Project/chat is active;
- what Codex/GPT is doing;
- what changed;
- whether checks/builds succeeded;
- which durable Results were produced;
- which repository/branch/user identity is involved;
- whether a collaborator needs attention;
- whether the execution machine/runtime is reachable;
- what the next meaningful action is.

The interface may expose many capabilities, but the common path should stay compact.

## Visual identity

The information architecture is shared while the product supports strong material skins such as:

- digital organizer;
- green CRT terminal;
- high-end early-2000s device/workstation;
- the current dark/default family.

Themes may feel materially different, but controls, status meaning, accessibility and collaboration boundaries must not change with the skin.

## Current non-goals / boundaries

CodexWeb should not become:

- a full browser replacement for VS Code;
- an arbitrary shell-orchestration platform exposed to the browser;
- a custom SSH implementation;
- a custom Remote Desktop protocol;
- a duplicate replacement for GitHub Issues/PRs/Reviews;
- a system where collaboration means sharing one person's native AI account/runtime;
- a reason to expose Windows/Codex services directly to the Internet;
- a system that silently mutates or rewrites another person's work because an AI suggested it.

Large features such as the Technical Viewer, writable file editor, Codex scheduling, broader communication/Result sharing and Brainstorm rooms are valid planned modules, but they should land as explicit bounded stages rather than being implied by this vision.

## Long-term success condition

CodexWeb succeeds when a user can do most routine AI-assisted development and collaboration from a tablet/phone/desktop without feeling that they are trapped inside a compromised Remote Desktop session — while the underlying repositories, machines, AI identities and collaboration permissions remain exact, private and recoverable.
