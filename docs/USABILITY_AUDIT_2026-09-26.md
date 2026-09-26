# End-user usability audit — 2026-09-26

## Scope

This audit reviews CodexWeb as an end-user product rather than as an implementation.

Questions:

- Does a new person understand what to do?
- Does an everyday user reach common actions quickly?
- Are names and navigation aligned with user intent?
- Does the UI expose too much internal architecture?
- Does mobile/tablet behavior fit the actual workflow?
- Does the visual system feel coherent and intentional?
- Where can the product become simpler without removing power?

Reviewed current main UI structure, major workspace modules, navigation, project overview, GPT/Codex surfaces, collaboration, Activity, Communication, Brainstorm, Files/Git/GitHub, Help, mobile/layout rules, theme CSS and the three visual reference directions.

This is not a physical-device acceptance run. Visual conclusions are based on current source/CSS/theme references and existing browser-layout contracts, not a fresh live-device screenshot sweep.

---

# Executive view

## The good news

The product concept is strong and unusually coherent underneath the surface:

- Project-first instead of machine-first is the right mental model.
- Separating conversation from Results is excellent.
- Separating GPT thinking from Codex implementation is useful.
- Activity vs directed Notifications is a good collaboration distinction.
- Private user runtimes plus explicit shared Spaces are logically clean.
- Mobile is treated as a real mode rather than a shrunken desktop.
- Draft/state preservation is much better than average.
- Destructive and uncertain operations are handled conservatively.
- The visual themes have a real identity rather than looking like generic SaaS.

The main usability problem is not missing capability.

It is **exposed complexity**.

CodexWeb has grown from one focused workspace into a platform, but much of the UI still exposes the platform's module names directly.

A user currently needs to understand a vocabulary like:

- Project
- Project GPT
- Intake
- Issue Drawer
- Core
- Notes
- Tasks
- Plans
- Reports
- Delivery
- Results
- Activity
- Space
- Space Chat
- Communication
- Brainstorm
- Files
- Git
- GitHub Files
- Remote
- Devices

Each term is defensible individually. Together they create cognitive load.

The next usability stage should therefore be **compression**, not another redesign of individual windows.

---

# 1. The strongest part: the everyday Project workspace

The core layout is good:

~~~text
Projects/navigation | conversation | Results/support
~~~

On compact screens this becomes one primary pane with explicit navigation rather than a squeezed desktop.

That maps well to how the product is actually used:

1. choose Project;
2. talk to Codex/GPT;
3. inspect output;
4. intervene manually only when needed.

The existing design decisions around preserving drafts, scroll, parent windows and source context are especially strong. A user can inspect a file/Result/source and return without losing the state they were working in.

This is one of CodexWeb's most important UX advantages and should be protected.

## Recommendation

Do not rebuild the core chat workspace.

Most improvements should happen around entry/navigation, naming, action discoverability, reducing secondary controls, and better handoffs between existing surfaces.

---

# 2. Biggest problem: too many product nouns

The UI currently asks users to learn the internal architecture.

Examples:

- Project GPT describes an implementation role, not a user goal.
- Project Intake is meaningful after explanation, but not self-evident.
- Issue Drawer describes a container, not the action.
- Delivery is broad and can mean build, deploy, Git delivery, or shipping.
- Core requires knowing what CodexWeb means by Core.
- Activity exists in more than one conceptual meaning.

This is manageable for the creator of the system, but much harder for a second user or future newcomer.

## Better rule

Navigation labels should answer:

> What am I trying to do?

rather than:

> Which subsystem implements it?

Examples:

| Current concept | More user-oriented entry wording |
| --- | --- |
| Project GPT | Discuss / Think |
| Project Intake | Analyze incoming work |
| Issue Drawer | Create Issues |
| Project Preparation | Prepare for Codex |
| Delivery | Review & publish |
| Core | Project brief / Project context |
| Reports | Work history / Reports |
| Files/Git/GitHub Files | Keep technical names inside one Project tools entry |

The underlying module names can remain in code and detailed docs.

---

# 3. Codex vs GPT: excellent concept, awkward top-level mode

The distinction itself is very good:

- GPT = think, discuss, analyze;
- Codex = implement.

The problem is presentation.

Today Codex and GPT still behave somewhat like two parallel applications, including a client switch in global navigation.

That makes the user think:

> Which app am I in?

instead of:

> What do I want to do with this Project?

## Recommended direction

Make the **Project** visually primary and Codex/GPT secondary modes inside it.

For example:

~~~text
Case Maker
[ Work ] [ Discuss ]              [...]
~~~

Where:

- Work opens current Codex;
- Discuss opens Project GPT;
- standalone GPT chats still live in a separate global GPT area for users who need them.

This would keep the existing two runtimes without making the user mentally switch products.

Do not remove the current client switch immediately. A good migration is to add project-level Work / Discuss actions first and see if the global toggle becomes rarely used.

---

# 4. Project Overview is useful but too dashboard-like

Project Overview currently exposes a lot:

- Project GPT;
- Issue Drawer;
- review/acceptance;
- Continue;
- Tasks;
- Plans;
- recent Results;
- context;
- Core;
- Reports;
- machine state;
- Remote;
- Files;
- Git.

This is powerful, but it reads like a control panel.

The user has to scan many similarly weighted cards before knowing what matters now.

## Better hierarchy

The overview should answer three questions in order.

### A. What is happening now?

- current Codex work;
- waiting question/approval;
- blocked/failed state;
- current PR/review;
- directed attention.

### B. What should I do next?

One to three high-value actions:

- Continue work;
- Discuss with GPT;
- Review result;
- Analyze incoming Issue;
- Start new work.

### C. Where is everything else?

Secondary sections:

- Files / GitHub;
- Tasks / Notes;
- Project context;
- history/reports;
- machine/Remote.

This keeps the overview useful without becoming a launchpad containing every module.

---

# 5. A global command/search palette would remove a lot of navigation pressure

CodexWeb has many local searches and many action entry points:

- project/chat search;
- Content Search;
- Help search;
- Brainstorm search;
- Communication search;
- file search;
- GitHub file navigation;
- various toolbar actions.

A context-aware command palette could unify much of this without putting more buttons on screen.

Suggested shortcut:

~~~text
Cmd/Ctrl + K
~~~

Possible searches/actions:

~~~text
Project: Case Maker
Chat: Export STEP
File: src/components/Sidebar.tsx
PR #42
Issue #81
Person: neflores
Open Results
Open Files
Discuss with GPT
New task
New chat
Remote
Settings
Switch theme
~~~

Scope should follow the current context, with an explicit way to broaden to all Projects.

This is a strong fit for CodexWeb because the product already has exact identities for most objects.

External precedent: GitHub uses a context-scoped command palette for navigation/search/actions. Raycast uses one searchable Action Panel instead of exposing every possible action permanently.

This should be additive, not keyboard-only. Touch users still need normal buttons.

---

# 6. Use one primary action plus contextual More more often

Several newer surfaces expose many actions directly.

Activity is a good example: source open, reactions, reply, discuss with GPT and related actions all compete inside a card.

The functionality is good. The visual priority can be simpler.

## Suggested pattern

Every object gets:

- one obvious primary action;
- maybe one high-frequency secondary action;
- a More menu for the rest.

Examples:

### Activity card

Primary:
- Open

Secondary:
- Reply

More:
- Discuss with GPT
- Analyze incoming work
- Copy link
- other reactions/actions

### Result card

Primary:
- Open

More:
- Share
- Save as
- Add to note/task
- Discuss with GPT

### File

Primary:
- Open

More:
- Edit
- Rename
- Move
- Download
- Delete

On desktop, Cmd/Ctrl+K on the selected object could open the same contextual action list.

This preserves power while improving scanability.

---

# 7. Terminology collision: Activity means too many things

There is collaboration Activity Timeline, but Codex also has an Activity pane/log concept.

To an end user these are not the same thing:

- Space Activity = what people/project objects have been doing;
- Codex Activity = technical execution detail/log.

Using the same word increases confusion.

## Recommendation

Keep **Activity** for collaboration.

Rename technical Codex activity to something like:

- Run details;
- Technical log;
- Work log;
- Execution.

Run details is probably the clearest user-facing option.

---

# 8. Attention is still distributed

CodexWeb correctly distinguishes Activity from Notifications, but attention can still appear in several places:

- Notifications;
- Communication unread;
- Space chat unread;
- Codex unread/completion;
- GPT jobs;
- review requests;
- failed/unknown operations.

The user may still need to scan several badges.

## Recommendation: one Inbox surface, without a new backend

Do not create another event store.

Use existing directed attention and unread sources to build one presentation layer:

~~~text
Inbox

Needs you
- Codex asks a question
- neflores requested review
- GPT send needs delivery check
- Space reply mentions you

Messages
- 2 unread DMs
- 1 unread Space chat
~~~

This is presentation/aggregation only.

Linear's Inbox is a useful model: attention-worthy updates are centralized, while ordinary project activity remains elsewhere.

Slack's Activity view similarly supports replying and triaging from a consolidated feed.

CodexWeb's existing Activity = awareness, Notifications = attention rule should remain; Inbox can simply become the friendlier surface name for attention.

---

# 9. Recents and Favorites are missing leverage

Project-first navigation is correct, but a long-term installation will accumulate many Projects/chats/Spaces.

The user should not have to repeatedly expand the tree to reach the same few things.

## Add a small top section

Not a dashboard. Just:

~~~text
Recent
- Case Maker · current chat
- World · Activity
- AltarProject · Project GPT

Pinned
- Case Maker
- Altar Collaboration
~~~

Notion's sidebar uses Recents, Favorites, Teamspaces and Private sections to keep a large workspace navigable without showing everything at once.

---

# 10. New-user onboarding should be intent-first

Project creation currently has the ingredients of a powerful setup wizard: machine, folder, repository, access and advanced profile settings.

For an experienced owner this is fine.

For a new user, machine + root + checkout + repository is implementation language.

## Better first question

~~~text
What do you want to do?

[ Open a project already on my computer ]
[ Clone/connect a GitHub project ]
[ Start a new project ]
[ Just brainstorm an idea ]
~~~

Then infer or skip steps:

- one machine configured -> do not ask which machine;
- one allowed root -> default it;
- folder is already a repository -> detect GitHub;
- GitHub project selected -> suggest clone/connect;
- advanced AI profile stays collapsed.

The existing wizard can remain underneath. This only changes the first layer.

---

# 11. Brainstorm is useful, but should feel lighter than Project

The current Brainstorm feature is capable enough that it risks becoming a second project-management surface.

Board, groups, links, drawing, chat, voice, GPT, settings and Project conversion are all defensible.

The important UX distinction should remain obvious:

> Brainstorm is cheap and temporary. Project is committed work.

## Recommendations

- Keep room creation extremely small: title + optional one-line purpose.
- Avoid showing advanced card relationship controls until requested.
- Make Turn into Project the obvious graduation action.
- Keep Tasks/Plans/Delivery out of Brainstorm.
- Prefer a visually looser board than Project workspace chrome.

The product already mostly follows this; keep resisting feature creep here.

---

# 12. Communication should remain small

The messenger redesign is a good direction:

- Chats / People;
- one-tap DM;
- explicit group creation;
- phone list-to-chat navigation.

This is much more understandable than exposing collaboration storage concepts.

Do not grow it into channels, complex threads, status/presence, roles, etc.

The current rule is good:

> conversation first; engineering object only when the conversation becomes engineering work.

---

# 13. Files/Git/Results are powerful but conceptually close

A new user can reasonably ask:

- Is the file in Files?
- Is it in Results?
- Is it Git?
- Is it GitHub Files?
- Is this the working copy or remote repository?

The implementation intentionally preserves these distinctions, which is correct.

The UI needs stronger identity cues.

## Recommendation

Every technical viewer/editor should carry a small source breadcrumb:

~~~text
Case Maker / Working copy / src/App.tsx
Case Maker / GitHub / main / src/App.tsx
Case Maker / Result / bracket_v2.step
~~~

Use the same source vocabulary everywhere:

- Working copy
- GitHub
- Result
- Shared copy

Avoid relying only on window title/icon/color.

A global Open/Search palette would make this distinction much easier because results can show source type explicitly.

---

# 14. Deep modal stacking: good continuity, but watch the window tunnel

CodexWeb correctly keeps parents mounted under nested viewers. This protects drafts/state.

The risk is ending up with:

~~~text
Project
 -> Activity
   -> PR
     -> File
       -> Editor
~~~

where closing only one level at a time can make the user lose sense of location.

## Recommendation

Keep the mounted-window architecture, but add a visible path when depth is greater than one:

~~~text
World  >  Activity  >  PR #42  >  src/api.ts
~~~

On phone this can be one back label plus current title.

This gives the benefits of preserved state without the feeling of modal nesting.

---

# 15. Visual audit

## Strong points

The three reference directions are distinctive:

- Organizer feels warm, personal and unusually friendly for a developer tool.
- Hi-Tech 2000s is memorable and fits the dedicated device/control-console idea.
- CRT is atmospheric and coherent.

The default Organizer choice is sensible.

The CSS architecture also shows good visual discipline:

- semantic base controls;
- shared workspace-window shell;
- 44px touch targets;
- explicit compact/tablet rules;
- keyboard viewport handling;
- reduced-motion awareness;
- theme-specific chrome mostly separated from content structure.

This is much better than adding a dark theme at the end.

## Main visual risk

The application has many late-added specialist windows. Even with a common shell, each has its own CSS and control density.

This can slowly turn into:

> same theme, different mini-apps

rather than one product.

Brainstorm is the clearest warning sign: it needs a lot of bespoke CSS and some important overrides because it is functionally complex.

## Recommendation

Do a periodic **component visual consolidation pass**:

- one header anatomy;
- one toolbar anatomy;
- one list row;
- one selected row;
- one card anatomy;
- one empty state;
- one error/recovery pattern;
- one mobile back pattern;
- one footer action pattern.

The current UI_LAYOUT_RULES document is already moving in this direction. Make these primitives more concrete in code rather than relying on feature CSS to reproduce them.

## Theme recommendation

For public screenshots and first impression:

1. Organizer as the main product identity.
2. Classic Dark as the serious everyday alternative.
3. Hi-Tech and CRT as expressive optional skins.

Hi-Tech and CRT are excellent differentiators but can visually compete with dense content. They should be a delight layer, not the baseline information architecture.

---

# 16. Help is excellent, but 53 articles are also a warning

The searchable contextual guide is genuinely useful.

It is especially good that:

- F1 is contextual;
- help does not start a tour;
- parent work remains mounted;
- search works locally;
- phone navigation is explicit.

But if common workflows require the guide often, that is discoverability debt.

## Rule

Help should explain uncommon concepts, recovery, and advanced workflows.

It should not be necessary to discover everyday navigation.

The best future metric is not add more help articles. It is:

> Which help articles are opened most often because the UI itself is unclear?

Use those topics to simplify the product.

---

# 17. Recommended target information architecture

Do not rebuild everything at once. This is a conceptual target.

## Global level

~~~text
Home
Projects
Spaces
Brainstorm
Inbox
Messages
~~~

Settings, Devices and Remote remain utility actions, not primary content categories.

Home can be very small:

- recent/pinned Projects;
- currently running work;
- things needing attention;
- quick New/Open actions.

No giant dashboard.

## Project level

~~~text
Case Maker

Work        -> Codex
Discuss     -> Project GPT
Results
Files
More...
~~~

More contains:

- Git / GitHub
- Tasks / Notes
- Project brief
- history/reports
- machine/Remote
- advanced tools

Overview remains available, but it becomes Project Home focused on Now / Next / Recent rather than a directory of every feature.

## Collaboration level

~~~text
Altar Collaboration

Projects
Activity
Chat
~~~

Activity = awareness.
Inbox = directed attention.
Chat = human conversation.

That is easy to explain.

---

# 18. Highest-value changes, in order

## 1. Add global command/search palette

High impact, low conceptual disruption.

It makes the growing feature set discoverable without adding chrome.

## 2. Rename or reframe user-facing modules by intent

Especially:

- technical Activity -> Run details;
- Project GPT entry -> Discuss;
- Intake entry -> Analyze incoming work;
- Issue Drawer entry -> Create Issues;
- Core -> Project brief/context.

Internal names can stay.

## 3. Simplify Project Overview to Now / Next / Project

Reduce equal-weight cards.

## 4. Add Recent/Pinned section

Small navigation improvement with high daily value.

## 5. Add visible nested-window breadcrumbs/back labels

Preserve current mounted-modal behavior while reducing disorientation.

## 6. Consolidate directed attention into an Inbox presentation

Reuse existing stores/events; no new parallel notification architecture.

## 7. Add intent-first Project setup entry

Keep the current wizard underneath.

## 8. Gradually make Project-level Work/Discuss more important than the global Codex/GPT switch

Do not remove the switch until usage proves it redundant.

---

# What I would NOT change

- Do not merge GPT and Codex into one magical agent.
- Do not merge Activity and Notifications.
- Do not collapse local Files and GitHub files into one fake filesystem.
- Do not make Remote the central workspace.
- Do not replace explicit confirmation/recovery with smart automation.
- Do not turn Brainstorm into Projects-lite.
- Do not add a public dashboard full of metrics.
- Do not remove the visual themes; they are part of the product's personality.
- Do not optimize only for desktop at the expense of iPad/phone.

---

# Overall assessment

## Logical model

**Very strong.**

The Project-centered model, distinct AI roles, Results separation and collaboration boundaries are better thought through than the navigation currently communicates.

## Everyday usability for the owner

**Good to very good.**

The owner knows the vocabulary, so the density becomes power rather than confusion. State preservation and mobile handling make the app unusually practical.

## Usability for a new second user

**Medium.**

The core workflow is learnable, but too many named subsystems and entry points make the first few sessions harder than necessary.

## Discoverability

**Medium.**

Contextual help is strong, but too much functionality is discoverable only after the user knows which window/module exists.

## Mobile/tablet

**Strong.**

The product genuinely thinks about viewport, software keyboard, one-pane phone navigation and preserved state.

## Visual identity

**Strong and memorable.**

Organizer is especially suitable as the product face. Hi-Tech/CRT are excellent optional personality layers.

The main visual risk is not ugliness; it is **control density and mini-app divergence** as more modules accumulate.

## Biggest opportunity

CodexWeb no longer needs more visible features.

It needs a **thin usability layer over the existing power**:

- one command/search surface;
- fewer visible top-level concepts;
- stronger intent-based labels;
- better recents/attention;
- clearer source/breadcrumb identity.

The underlying product is already much more coherent than the surface makes it look.
