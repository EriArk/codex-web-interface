# CodexWeb

**Run a real AI-assisted development workflow from a browser — without turning Remote Desktop into your IDE.**

CodexWeb connects **Codex, ChatGPT, your actual project files, GitHub, generated results and collaborators** into one project-centered workspace that works on iPad, iPhone and desktop.

It is self-hosted, private, and designed for people who actually use AI to build things — not just chat about code.

---

## Why does this exist?

Because the useful parts of an AI development workflow usually live in different places.

You might:

- discuss an idea in ChatGPT;
- ask Codex to implement it on another machine;
- open GitHub to understand what changed;
- dig through a filesystem for generated files;
- remote into Windows just to inspect one thing;
- copy a commit, PR or error back into another AI chat for explanation;
- message a teammate somewhere else;
- then try to remember how all of that fits together tomorrow.

Every tool is doing its own job.

The problem is the **workflow between them**.

CodexWeb is built to make that workflow feel like one place.

> **The Project is the center.  
> Codex does the work.  
> GPT helps you think.  
> GitHub keeps the engineering truth.  
> CodexWeb keeps all of it connected.**

---

## The basic idea

Open a Project in CodexWeb and you are not opening a disposable AI chat.

You are opening a workspace that knows:

- which repository belongs to the project;
- where the real checkout lives;
- which machine can build/run it;
- which Codex conversation is current;
- which Project GPT belongs to it;
- what files and Results were produced;
- what work is on GitHub;
- what other projects and people are related to it.

A typical flow can look like this:

```text
Idea
 ↓
Brainstorm / Project GPT
 ↓
Prepare the work
 ↓
Codex edits the real project
 ↓
Inspect Files / Results / builds
 ↓
Review the change
 ↓
Commit / branch / PR
 ↓
Collaborators see Activity
 ↓
Feedback becomes the next piece of work
```

The important part is not that CodexWeb has all of those screens.

The important part is that **you do not lose the context between them**.

---

# What does that actually let me do?

## Work on your real development machine from an iPad or phone

This was the original reason for building CodexWeb.

Say the project lives on a Windows workstation.

From an iPad I can open the Project, continue the same native Codex conversation, ask for a change and let Codex work against the **real checkout and real toolchain** on that machine.

I see the conversation, questions, approvals, progress, changed files and useful outputs in the browser.

I do **not** need to stare at a scaled-down Windows desktop while the agent works.

If I need to touch the actual GUI, Remote Desktop is one click away.

That makes Remote the exception instead of the entire mobile development experience.

---

## Think with GPT, then hand the result to Codex

Codex and ChatGPT are useful for different things, so CodexWeb treats them differently.

### Project GPT

Each Project can have its own persistent private GPT conversation.

That is where I can:

- throw around product ideas;
- discuss architecture;
- ask questions about the project;
- study a teammate's PR or commit;
- ask how a change in one Project affects another;
- prepare a clean implementation package.

Project GPT already knows what Project it belongs to. When I open a commit or Activity item, I can hand it the **exact source evidence** instead of copy-pasting a summary.

### Codex

Codex is for implementation.

It gets the actual Project, checkout, tools and working context.

So instead of asking one giant AI chat to be architect, project manager, developer and reviewer at the same time, the workflow is deliberately split:

> **GPT: “What should we do?”**  
> **Codex: “Do it.”**

---

## Turn a discussion into real engineering work

Once an idea is settled, **Prepare for Codex** can turn a Project GPT discussion into a reviewed package:

- documentation;
- reference files;
- initial Issues;
- a GitHub branch/commit/PR where appropriate;
- an exact handoff back into the Project.

Nothing is published just because the model suggested it.

You review the package first.

The same idea appears elsewhere in the product: AI can prepare work, but important mutations stay explicit.

---

## Inspect and edit files without opening the desktop

CodexWeb has a real Files workspace.

You can:

- edit text/code in CodeMirror;
- upload and download files;
- create files and folders;
- rename, copy, move and delete;
- select many files at once;
- merge folders with per-file decisions;
- recover interrupted operations;
- download selected files/folders as a ZIP.

If a generated Result is useful, you can open it directly without hunting through the project directory.

And because my projects are not only web apps, the viewer understands more than source code.

It can inspect:

- images and PDF;
- text, Markdown, JSON, YAML, XML, CSV;
- HTML and SVG;
- STEP / STP;
- IGES / IGS;
- STL, OBJ, 3MF, GLB / glTF;
- DXF;
- ZIP;
- DOCX;
- XLSX;
- audio/video supported by the browser.

It is a viewer, not an attempt to replace CAD or Office.

The point is simple: **if Codex produced something, I want to be able to look at it where I am already working.**

---

## Work with GitHub without constantly leaving the app

GitHub remains the source of truth for repository history and collaboration.

CodexWeb does not replace it.

It just brings the parts I use during an AI-assisted workflow into the same workspace.

You can inspect commits, Issues, PRs, reviews and checks, and you can edit GitHub files directly when that is the right tool for the job.

From the integrated editor you can:

- edit/create/rename/delete repository files;
- create a branch;
- commit reviewed changes;
- open a PR;
- recover an uncertain GitHub operation without accidentally doing it twice.

Local files and GitHub files are treated as different things. A remote commit does not silently rewrite your local checkout.

---

# What happens when more than one person works on the project?

I did **not** want teamwork to mean:

> “Here is one giant shared workspace. Please use my accounts and my machine.”

Each person keeps their own:

- Codex account;
- ChatGPT account;
- GitHub identity;
- machine;
- checkout;
- private chats;
- drafts and personal state.

A **Collaboration Space** connects real Projects owned by real people.

Example:

```text
Altar Collaboration

Lazar
└── AltarAppsReborn

neflores
└── World
```

Those are still two independent Projects.

The Space only says how they are related and what each participant is allowed to do.

GitHub permissions remain real GitHub permissions.

CodexWeb can help grant/accept Write access, manage the participant's working copy and keep it synchronized, but it does not pretend that a local permission toggle can override GitHub.

---

## See what your teammate actually did

A shared Project does not need another AI-generated “daily status report”.

There is already better evidence:

- commits;
- PRs;
- Issues;
- reviews;
- Results;
- project changes.

So Collaboration Spaces have an **Activity Timeline**.

Instead of:

```text
neflores pushed
neflores pushed
CI started
CI finished
commit
commit
commit
```

you can get something closer to:

```text
neflores · World

Updated location-system API
3 commits · PR #42 · checks passed

[Open] [Reply] [Discuss with GPT]
```

From there you can:

- open the exact source;
- react;
- leave a short reply;
- send a directed notification;
- discuss the exact change in your Project GPT;
- study it technically in Project Intake.

The distinction is intentional:

> **Activity = “what is happening?”**  
> **Notifications = “what needs me?”**

---

## Turn feedback into the next task

Suppose your teammate changes an API.

You open that Activity item, inspect the actual commit and ask Project GPT:

> “Does this break anything in my project?”

If the answer uncovers real work, you can collect finished Issue drafts into **Issue Drawer**, review them, choose the correct repositories and publish them under your actual GitHub identity.

The other person can then open those incoming Issues in **Project Intake**, let Codex study the technical evidence, review the proposed plan and explicitly hand it to normal Project Work.

That gives CodexWeb a collaboration loop like:

```text
work
 ↓
GitHub
 ↓
Activity
 ↓
human / GPT review
 ↓
Issues
 ↓
Intake
 ↓
Codex work
```

without two agents endlessly talking to each other behind everyone's back.

---

# What about ideas that are not projects yet?

Sometimes there is no repository.

There is just:

> “Wouldn't it be cool if…”

That is what **Brainstorm Rooms** are for.

A room has:

- a shared board;
- notes, links and files;
- simple drawing;
- card grouping and connections;
- common chat;
- lightweight voice;
- one private GPT per participant.

When the idea becomes real, selected material can be frozen into a snapshot and turned into a normal Project.

So instead of losing the useful parts of a brainstorm when implementation starts:

```text
Brainstorm
   ↓
Project
   ↓
Project GPT
   ↓
Prepare for Codex
   ↓
real implementation
```

The messy thinking space and the engineering project stay connected without becoming the same thing.

---

# And normal human messaging?

Not every conversation is an Issue or a Project discussion.

CodexWeb also has direct messages and small groups.

Files and Results can be shared explicitly to:

- a person;
- a group;
- a Collaboration Space;
- a Brainstorm Room.

Shared Results are immutable snapshots with their own access grants. Sending a generated file to somebody does not give them access to your machine, private chat or source path.

Again: the idea is not to replace Discord.

It is to make the things produced during development easy to pass to the right person without breaking the workflow.

---

# What else is in there?

The current product also includes:

- **Project Core** for durable project context;
- **Notes and Tasks**;
- **Plans** and Reviews;
- **Delivery** for branch / commit / PR workflows;
- **scheduled Codex messages**;
- **project-specific AI behavior profiles**;
- **dictation and read-aloud**;
- **push/in-app notifications**;
- **device terminals and health/diagnostics**;
- **Remote Desktop** through Guacamole;
- **phone, tablet and desktop layouts**;
- four full visual themes;
- contextual help plus a searchable in-app guide.

There is a lot in CodexWeb now, but these are all supposed to support the same core loop — not turn the app into a giant dashboard.

---

# Why not just use Remote Desktop?

You can.

And sometimes it is the fastest solution.

But try using a Windows desktop as your primary development interface from a phone or iPad for a few hours.

Most of the time you do not actually need the desktop.

You need to:

- tell Codex what to do;
- answer a question;
- inspect a file;
- see a screenshot;
- review a diff;
- open a PR;
- check whether something passed;
- reply to a teammate.

Those things deserve a proper mobile/web interface.

**Remote exists for the remaining 10%, not the other 90%.**

---

# Why not just use ChatGPT / Codex / GitHub separately?

You absolutely can.

CodexWeb is useful if the friction **between** them starts bothering you.

It is for the moment when you realize you keep doing things like:

> copy commit → paste into GPT → explain repository → get answer → switch to Codex → explain it again → open GitHub → find the PR → remote into PC → locate generated file

CodexWeb tries to collapse that into:

> **open the Project → everything already knows what it belongs to**

That is the whole point.

---

# How is it built?

There is one Internet-facing **Linux Hub**.

The browser talks to the Hub. The Hub talks to the machines and private AI runtimes.

```text
iPhone / iPad / Desktop browser
            │
          HTTPS
            │
      ┌─────▼─────┐
      │ Linux Hub │
      └──┬─────┬──┘
         │     │
         │     └── private per-user ChatGPT runtime
         │
         └── trusted SSH → Windows/Linux development machine
                         ├─ Codex
                         ├─ project files
                         ├─ Git / GitHub
                         └─ RDP/VNC → guacd → browser
```

The Windows PC stays a normal workstation. It does not expose Codex or project files directly to the Internet.

CodexWeb currently targets private/self-hosted use by an individual or small trusted team.

---

# A note about reliability

A lot of effort in this project goes into a boring question:

> “What if the operation succeeded, but the response disappeared?”

That matters when the operation is:

- sending a prompt;
- saving a file;
- committing to GitHub;
- creating an Issue;
- moving a directory;
- running a scheduled message.

CodexWeb generally refuses to solve uncertainty with “eh, try it again”.

Important operations have stable identities and durable receipts. If the system cannot prove whether something happened, it reconciles the existing operation instead of blindly repeating it.

The same principle is used for stale file versions, changed branch heads and revoked collaboration access.

This is a big part of why the project is comfortable to use on real work instead of only demos.

---

# What is CodexWeb not?

It is not trying to become:

- VS Code in a browser;
- another GitHub;
- another ChatGPT;
- another Jira;
- another Slack/Discord;
- an autonomous multi-agent company;
- a public multi-tenant SaaS.

When another tool already owns something well, CodexWeb tries to **connect to it rather than poorly reimplement it**.

---

# Current limits

A few things are still deliberately incomplete:

- physical iPhone/iPad/PWA/audio/gesture acceptance is tracked separately from browser automation;
- the private native ChatGPT provider is version-sensitive and fail-closed;
- native ChatGPT's upstream canonical graph is still read as a whole even though CodexWeb incrementally projects it afterward;
- managed collaboration copies do not yet automatically provision a full isolated test-service stack;
- deployment is still an operator-managed self-hosted setup rather than a polished one-click installer;
- CAD/Office/archive support is for inspection, not full editing/conversion.

The project evolves quickly, so an open GitHub issue may describe a larger ideal end-state even when most of the feature is already implemented.

See [the current backlog review](docs/BACKLOG_REVIEW_2026-09-24.md) and [Roadmap](docs/ROADMAP.md).

---

# Run it

CodexWeb is currently a private self-hosted installation.

Typical setup:

1. Linux Hub with HTTPS.
2. Your Windows/Linux development machine reachable from the Hub over trusted LAN/Tailnet.
3. System SSH for project operations.
4. Optional RDP/VNC + `guacd` for Remote Desktop.
5. Optional private ChatGPT runtime.
6. GitHub authenticated under the actual user who will perform GitHub work.

Start with [Deployment](docs/DEPLOYMENT.md).

For adding another trusted user/machine, see [Friend quick start](docs/FRIEND_QUICKSTART.md) and [Windows enrollment](docs/WINDOWS_ENROLLMENT.md).

Do not expose Windows SSH/RDP/VNC, `guacd`, Codex App Server or the databases directly to the Internet.

---

# Development

Requirements:

- Node.js 24.18.x
- pnpm 11.13.1
- system OpenSSH
- Chromium/WebKit tooling for browser tests

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

# Repository

| Path | Purpose |
| --- | --- |
| `apps/web` | React/PWA user interface |
| `apps/hub` | Hub, private runtimes, storage, AI/collaboration/recovery logic |
| `packages/shared` | Shared schemas and contracts |
| `packages/codex` | Native Codex protocol layer |
| `packages/machines` | Local/SSH file, Git, GitHub and machine operations |
| `ops` | Deployment, native GPT runtime and Windows helpers |
| `tests` | Backend/integration tests and Chromium/WebKit product flows |
| `docs` | Detailed feature contracts, security, operations and audits |

---

# Read more

If the idea makes sense and you want the details:

- [Workspace](docs/WORKSPACE.md)
- [Prepare for Codex](docs/PROJECT_PREPARATION.md)
- [Project Intake](docs/PROJECT_INTAKE.md)
- [Files and editor](docs/FILE_EDITOR.md)
- [File / CAD / Office viewers](docs/FILE_VIEWERS.md)
- [Collaboration Spaces](docs/COLLABORATION_SPACES.md)
- [Activity Timeline](docs/SPACE_ACTIVITY.md)
- [Communication and Result sharing](docs/COMMUNICATION.md)
- [Brainstorm Rooms](docs/BRAINSTORM.md)
- [Security](docs/SECURITY.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Verification](docs/VERIFICATION.md)

---

## In one sentence

**CodexWeb is the workspace between “I have an idea” and “the change is implemented, reviewed, on GitHub, and everybody involved knows what happened.”**
