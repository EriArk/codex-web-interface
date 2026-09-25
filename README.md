# CodexWeb

**A private workspace that ties AI, code, GitHub and people together around the thing you actually care about: the project.**

CodexWeb started from a very simple annoyance.

Codex can do real work because it runs next to the project, its files and its toolchain. ChatGPT is useful for thinking through ideas and architecture. GitHub is where the durable engineering history belongs. Remote Desktop is useful when you need to touch the real machine.

But normally those are four separate places.

You discuss an idea in one window, copy it into another, watch an agent work somewhere else, hunt for the files it produced, open GitHub to see what actually changed, then remote into the PC because one small thing is missing from the web UI.

**CodexWeb is my attempt to make that feel like one continuous workspace instead.**

It does not replace Codex, ChatGPT or GitHub. It connects them.

---

## The idea

The central object in CodexWeb is not a chat and not a computer.

It is a **Project**.

A Project knows where its real checkout lives, which machine can run it, which Codex conversation is current, which GitHub repository belongs to it, what useful results have been produced, what the project is trying to do, and which other people or projects are related to it.

That lets the workflow look like this:

```text
                ┌─────────────────┐
                │      Idea       │
                │ Brainstorm / GPT│
                └────────┬────────┘
                         │
                         ▼
                ┌─────────────────┐
                │     Project     │
                │ context + repo  │
                └────────┬────────┘
                         │
              discuss / prepare work
                         │
              ┌──────────▼──────────┐
              │     Project GPT     │
              │ think / analyse /   │
              │ prepare             │
              └──────────┬──────────┘
                         │
                         ▼
              ┌─────────────────────┐
              │        Codex        │
              │ edit / build / run  │
              │ on the real machine │
              └──────────┬──────────┘
                         │
                         ▼
              ┌─────────────────────┐
              │ Files / Results /   │
              │ Review / GitHub     │
              └──────────┬──────────┘
                         │
                         ▼
              commits / PR / feedback
                         │
                         ▼
              Activity / collaborators
```

The important bit is that **the context survives the jumps between those stages**.

You should not have to keep explaining which repository you mean, which project another change belongs to, where a generated file came from, or which commit a discussion is about.

---

## A normal day with CodexWeb

Imagine I am working on two related projects from an iPad.

I open one Project and continue the same Codex thread that is actually running against the checkout on my Windows PC. I ask for a change. Codex edits the real files, runs the real tools and streams the useful progress back into the web UI.

While it works, I do **not** need to watch a remote desktop.

When it finishes, the conversation stays readable and the useful outputs are somewhere sensible: changed files, images, reports, CAD exports, checks, screenshots and other artifacts live in **Results** instead of burying the chat.

If I want to inspect or tweak something myself, I can open **Files**. Text files have a real editor. Technical files can open in the shared viewer. Git and GitHub are available in the same workspace.

If the work needs a branch or PR, I can review the exact change and publish it without leaving CodexWeb.

If I need the real GUI, **then** I open Remote Desktop.

That is the basic product.

Everything else grew from trying to preserve that same feeling when projects became larger and more collaborative.

---

## Two different AI jobs

CodexWeb deliberately does not treat every AI conversation as the same thing.

### Project GPT — think with me

Each Project can have its own persistent private ChatGPT conversation.

I use it for things like:

- discussing product and architecture;
- looking at a change made by somebody else;
- asking what a PR means for another project;
- turning a vague idea into a concrete implementation package;
- preparing docs and Issues before implementation starts.

Project GPT knows which Project it belongs to. It can be given exact GitHub/Activity evidence instead of a pasted summary.

It is a **companion and analyst**, not an automatic code executor.

### Codex — do the work

Codex is the implementation side.

It works against the actual project checkout and toolchain. Its conversation is connected to the real files, builds, tests and native Codex state.

So the split is intentionally simple:

> **GPT helps decide what should happen. Codex makes it happen.**

There is also **Project Intake**, a separate read-only Codex lane for incoming Issues, PRs, Activity and feedback. It can study the technical evidence and prepare a handoff without polluting the normal implementation conversation or silently starting work.

---

## Chat is not the database

One of the design decisions behind CodexWeb is that useful work should not disappear into AI chat history.

A Project has durable things outside the conversation:

- Core project context;
- Notes and Tasks;
- Plans;
- Results;
- Reviews;
- Git/GitHub state;
- prepared Issues;
- source links and exact references.

The chat is where work happens.

The Project is where the useful state lives.

That distinction is what makes it possible to reopen a project later and still understand what is going on without asking an AI to reconstruct everything from a thousand-message conversation.

---

## Files and Results are first-class

A lot of AI development tools stop at “the agent changed some files”.

CodexWeb treats the produced files as part of the workflow.

**Files** is a real working surface: edit text, upload/download, create, rename, copy, move, delete, batch operations, folder merging and conflict-aware recovery.

The same editor can also work against GitHub directly when I want to make a reviewed remote change without touching the local checkout. From there I can create a branch, commit and open a PR.

**Results** is for outputs worth seeing or keeping: generated files, images, previews, reports and other artifacts tied back to the work that produced them.

Both use a common viewer. Today it can inspect normal text/images/PDF/HTML/SVG as well as things I personally care about for engineering work: STEP, IGES, STL, OBJ, 3MF, GLB/glTF and DXF. ZIP, DOCX and XLSX can also be inspected without pretending CodexWeb is a full Office suite or CAD package.

---

## Collaboration without a fake “shared computer”

When another person joined the project, I did not want collaboration to mean:

> “Here is one giant shared workspace. Please use my accounts and my machine.”

Each user keeps their own:

- Codex;
- ChatGPT;
- GitHub identity;
- machines;
- project checkout;
- private chats and drafts.

A **Collaboration Space** only connects the parts that are actually shared.

For example:

```text
Altar Collaboration

Lazar
└─ AltarAppsReborn

Lev
└─ World
```

Both are still real independent Projects.

The Space says how they relate, which access each participant has to each Project, and gives the team a human chat and a shared Activity view.

GitHub remains the source of truth for code, Issues, PRs and Reviews.

A participant can work in their own copy, sync it safely with upstream and propose work back through normal GitHub flows. Full/direct access can grant GitHub Write using the real owner's and participant's verified identities; CodexWeb never quietly falls back to somebody else's account.

---

## Activity instead of status reports

I originally considered automatic “Work Reports”.

That turned out to be the wrong abstraction.

GitHub already knows about commits, PRs, Issues and reviews. Results already know about produced artifacts. CodexWeb already knows about Projects and collaboration.

So instead, a Space has an **Activity Timeline**.

It answers:

> **What has the other person actually been doing?**

Related commits can be grouped into one readable entry. Exact commits/PRs/Issues open inside the workspace. People can react, leave a short reply, or hand the exact evidence to Project GPT / Intake.

Routine activity stays in Activity.

Only things that actually need your attention — a directed reply, review request, access request, and similar events — belong in Notifications.

> **Activity is awareness. Notifications are attention.**

---

## Ideas before they become projects

Not everything begins as a repository.

**Brainstorm Rooms** are intentionally loose spaces for early ideas.

A room has a shared board, files/references, common chat, lightweight voice and a private GPT for each participant. Cards can be grouped, linked and arranged spatially.

When the idea becomes real, a reviewed snapshot of the useful material can become a normal Project.

So the flow is not:

```text
random chat → manually create repository → manually copy context
```

It can be:

```text
Brainstorm
    ↓
Project
    ↓
Project GPT
    ↓
Prepare for Codex
    ↓
implementation
```

The messy idea space remains available, but the implementation gets its own clean project identity.

---

## Communication is separate from engineering state

People also need to talk without turning everything into an Issue.

CodexWeb has direct and small-group conversations, plus the chat inside Spaces and Brainstorm Rooms.

Files and Results can be shared through explicit grants. Sharing a Result does not expose the sender's private filesystem path or private AI conversation.

If a discussion turns into real engineering work, *then* it can become an Issue, Intake package or PR.

I am deliberately trying not to recreate Slack, Discord, Jira and GitHub inside one app.

---

## Remote Desktop is the escape hatch

The project originally grew out of wanting to work from an iPad without constantly remoting into Windows.

That principle is still important.

Most normal work should be possible through structured web surfaces:

```text
talk → work → inspect → review → publish
```

Remote Desktop exists for the cases where direct interaction is genuinely faster:

- testing a GUI;
- clicking something that has no API;
- checking the real desktop state;
- fixing one awkward thing manually.

It uses Guacamole with phone/tablet touch and trackpad-style controls.

Remote is useful.

**Remote is not the product.**

---

## Why a Linux Hub?

The Hub is the piece that makes all of this feel continuous.

The browser talks only to the Hub.

The Hub knows which user, Project, machine, checkout, repository and AI conversation a request belongs to. It keeps private state, Results, queues and recovery receipts. It talks to execution machines over trusted connections and mediates Remote Desktop.

```text
                           Browser / PWA
                                │
                           HTTPS / WSS
                                │
                        ┌───────▼───────┐
                        │   Linux Hub   │
                        │               │
                        │ auth          │
                        │ Projects      │
                        │ private state │
                        │ AI bindings   │
                        │ Results       │
                        │ collaboration │
                        │ recovery      │
                        └───┬───────┬───┘
                            │       │
                    trusted │       │ private
                    machine │       │ ChatGPT runtime
                            │       │
                   ┌────────▼───┐   │
                   │ Windows /  │   │
                   │ Linux      │   │
                   │            │   │
                   │ Codex      │   │
                   │ files      │   │
                   │ git / gh   │   │
                   └─────┬──────┘   │
                         │          │
                    RDP/VNC         │
                      via guacd     │
```

The Windows machine stays a normal machine. There is no public Codex listener on it. The Hub reaches it through system SSH / private local helpers, and Remote services are intended to be reachable only from the Hub/LAN/Tailnet.

---

## Private by default

Multi-user support did not change the basic privacy model.

Every person has their own private runtime and state. Sharing a Project does not share the owner's native Codex history, ChatGPT transcript, machine, terminal or unrelated files.

Installation administration is also separate from content access: being an admin is not supposed to magically become “read everybody's chats”.

The important rules are:

- resolve the exact user before selecting a runtime;
- bind work to exact Project / checkout / repository / conversation identities;
- re-check authorization around asynchronous operations;
- never treat a copied object ID as permission;
- never use another user's credentials as a fallback.

See [Security](docs/SECURITY.md) for the full boundary.

---

## Recovery is part of the design

CodexWeb sits on top of systems where a request can succeed and the response can still get lost:

- a file may already have been saved;
- a GitHub commit may already exist;
- a prompt may already have been submitted;
- a scheduled action may already have crossed the send boundary.

So one rule appears everywhere in the project:

> **Do not blindly retry a mutation just because the acknowledgement disappeared.**

Important operations use durable identities/receipts and explicit reconciliation.

If the system cannot prove whether something happened, the state becomes **unknown** instead of “probably failed, let's send it again”.

The same philosophy is used for stale file versions, GitHub branch heads, collaboration access changes and AI sends.

It is not the most glamorous part of CodexWeb, but it is one of the reasons I trust it with real projects.

---

## What is already there?

The project is well past the “Codex chat in a browser” stage.

The current codebase includes, among other things:

- native Codex project/chat work from the browser;
- private consumer ChatGPT integration;
- Project GPT and Project Intake;
- Prepare for Codex and Issue Drawer;
- writable Files and direct GitHub file workflows;
- Results and technical/Office/archive viewers;
- Review, Delivery, branches and pull requests;
- scheduled Codex messages;
- Collaboration Spaces and managed working-copy sync;
- Activity, reactions, replies and directed notifications;
- direct/group communication and immutable Result sharing;
- Brainstorm Rooms with board/chat/voice/private GPT;
- Remote Desktop, terminals, dictation, read-aloud and device tooling;
- phone, tablet and desktop/PWA layouts;
- a searchable in-app help system.

For exact feature contracts and limitations, use the docs linked below rather than treating this README as an exhaustive specification.

---

## What CodexWeb is *not*

This is a private personal/small-team project, not a general hosted platform.

It is also intentionally **not**:

- VS Code rewritten in React;
- a replacement for GitHub;
- a replacement for ChatGPT;
- a Slack/Discord clone;
- a Jira clone;
- an autonomous swarm of agents talking to each other forever;
- a system that gives AI unrestricted shell/GitHub access because “the user probably meant it”.

Where an existing tool already owns something well, CodexWeb tries to keep that tool authoritative and build a better workflow around it.

---

## Current rough edges

A few boundaries are still intentional/current:

- physical iPhone/iPad/PWA/audio/gesture acceptance is tracked separately from Chromium/WebKit automation;
- the native ChatGPT provider is version-sensitive and deliberately fail-closed;
- native ChatGPT history is incrementally projected inside CodexWeb, but the upstream canonical native graph is still read as a whole;
- collaboration copies have managed sync/reconciliation, but automatic isolated test-service provisioning is still future work;
- there is no polished one-click public installer for arbitrary Hub deployments yet;
- CAD/Office/archive support is inspection-oriented, not full editing fidelity;
- the project moves quickly enough that some open Issues describe a broader ideal end-state even after most of the feature has landed.

See the [latest backlog review](docs/BACKLOG_REVIEW_2026-09-24.md) and [Roadmap](docs/ROADMAP.md) for the implementation/remainder split.

---

## Running it

CodexWeb is currently an operator-managed private installation.

Typical deployment:

```text
Internet
   │
 HTTPS
   │
Linux Hub
   ├─ trusted SSH → Windows/Linux execution machine
   ├─ guacd → private RDP/VNC
   └─ optional private per-user ChatGPT runtime
```

Start with [Deployment](docs/DEPLOYMENT.md).

For another trusted user/machine, see [Friend quick start](docs/FRIEND_QUICKSTART.md) and [Windows enrollment](docs/WINDOWS_ENROLLMENT.md).

Do **not** expose Windows SSH/RDP/VNC, guacd, native Codex/App Server or the databases directly to the Internet.

---

## Development

Requirements:

- Node.js 24.18.x
- pnpm 11.13.1
- system OpenSSH for real remote-machine work
- Chromium/WebKit tooling for browser regression tests

```bash
corepack enable
pnpm install --frozen-lockfile

pnpm build
pnpm typecheck
pnpm lint
pnpm test

HUB_CONFIG=/absolute/path/config.yaml pnpm start
```

For loopback development use `publicBaseUrl: http://127.0.0.1:8780` with secure cookies disabled. Non-loopback deployments require HTTPS.

Copy [config.example.yaml](config.example.yaml) outside the repository and keep secrets out of Git.

---

## Repository map

| Path | What lives there |
| --- | --- |
| `apps/web` | React PWA and all user-facing workspaces |
| `apps/hub` | Fastify Hub, private runtimes, SQLite, queues, AI/collaboration/recovery logic |
| `packages/shared` | Shared validated contracts and schemas |
| `packages/codex` | Native Codex App Server protocol/compatibility layer |
| `packages/machines` | Local/SSH file, Git, GitHub and machine operations |
| `ops` | Linux deployment, native GPT runtime, Windows helpers and speech setup |
| `tests` | Backend/integration tests and Chromium/WebKit product flows |
| `docs` | Feature contracts, architecture, security, operations and historical audits |

---

## Useful docs

### Product/workflow

- [Workspace](docs/WORKSPACE.md)
- [Brainstorm Rooms](docs/BRAINSTORM.md)
- [Project behavior profiles](docs/PROJECT_AGENT_PROFILES.md)
- [Prepare for Codex](docs/PROJECT_PREPARATION.md)
- [Project Intake](docs/PROJECT_INTAKE.md)
- [Issue Drawer](docs/ISSUE_DRAWER.md)
- [Codex schedules](docs/CODEX_SCHEDULES.md)

### Files / Git / results

- [Writable Files and editor](docs/FILE_EDITOR.md)
- [File and technical viewers](docs/FILE_VIEWERS.md)
- [Project Review](docs/PROJECT_REVIEW.md)
- [Project Delivery](docs/PROJECT_DELIVERY.md)

### Collaboration

- [Collaboration Spaces](docs/COLLABORATION_SPACES.md)
- [Activity Timeline](docs/SPACE_ACTIVITY.md)
- [GitHub Write in Spaces](docs/SPACE_GITHUB_WRITE.md)
- [Managed checkout sync](docs/CHECKOUT_SYNC.md)
- [Communication and Result sharing](docs/COMMUNICATION.md)

### Operations

- [Architecture](docs/ARCHITECTURE.md)
- [Security](docs/SECURITY.md)
- [Deployment](docs/DEPLOYMENT.md)
- [Maintenance](docs/MAINTENANCE.md)
- [Verification](docs/VERIFICATION.md)
- [Native ChatGPT integration](docs/GPT_NATIVE_LINUX.md)

---

## The short version

CodexWeb is the workspace I wanted between **an idea** and **a finished change in a real project**.

It keeps the thinking, implementation, files, results, Git history and human collaboration connected without pretending they are all the same thing.

**GPT helps me think. Codex does the work. GitHub keeps the engineering truth. CodexWeb keeps the whole workflow together.**
