# UX Specification

## Direct Files/Git windows and Results — 2026-09-13

The Codex header has separate folder and branch buttons for Files and Git. Each opens a native modal bound to the selected private project/checkout. The former combined support-pane tab is removed. Settings remains in the sidebar footer in both Codex and GPT; it no longer occupies the top bar.

Settings now has one persistent host shared by Codex and GPT. Its six categories and common controls are identical in both modes. The overview always includes Codex usage/reset availability; Connections separates Codex, GPT and computers, and Projects/history includes both catalogs and archives with clear client labels. Merely opening Settings never reconnects GPT or performs desktop maintenance.

The sidebar Remote button always opens a configured Windows PC in a full-viewport modal above the current client. Returning preserves the mounted chat/composer and its draft; while Remote covers it, the chat is not considered read. The selected Codex project's PC takes precedence; otherwise choose the sole available PC or show a machine chooser. The protected server ChatGPT browser is an explicit new-tab link in Settings → Connections → GPT. Missing PC configuration never falls back to that browser.

On wide screens Files uses a folder/file list beside a content preview. Automatic previews are limited to 2 MiB and use authenticated project-root reads with cancellation; larger files retain the explicit Open action. Phones keep file actions at the selected row and open content in the existing preview window. Files still explicitly reports read-only; the writable lock is deferred until typed server operations and the #158 upgrade prerequisite are ready.

Git has its own broad window, with repository identity/status, README beside commits/branches/tags, changes/diff and releases. Close preserves the underlying chat draft and view; project changes discard old window context. Late responses cannot populate a different project's window.

Codex Results uses the whole project's authorized library without a Dialog/Project switch. Category pagination, exact artifacts and their source chat/turn remain intact. GPT shares the material redesign, but project aggregation is pending the server contract; its current conversation feed is not advertised as project-wide.

## Current team milestone

The approved [Team Workspace](TEAM_WORKSPACE.md) adds user identity and explicit collaboration to the same functional themed UI. Desktop and mobile are both required for the second user. Owner-enabled functionality is installed; admission of a real second user is still pending. Subsequent changes are tested separately before installation.

- Access settings contain personal account/security; admins additionally see users/invitations and machine-pairing metadata. Personal content never appears in an administrative user preview.
- Joining follows invitation → own credentials → Windows master → chosen project folders → diagnostics → admin-approved PC. Native Codex/GPT/GitHub sign-ins have independent readiness states; one unavailable account does not masquerade as another person's connection.
- Navigation distinguishes My projects and Shared with me. Shared project headers name owner/role and the current user's checkout. Files/Git, chat and work target that checkout; opening the overview preserves existing drafts and selection.
- Sharing an existing project shows a material-selection review. New common project records show their shared audience; personal capture remains explicit. Private source links keep published evidence readable without opening the source.
- Project membership uses Viewer/Collaborator/Owner. Show authors, assignments, revision conflicts and useful activity, preserving drafts. Do not add presence surveillance or mandatory self-review bureaucracy.
- Links invite the other owner without listing their private projects. Bridges prioritize goal, questions, findings, decisions and action state. Show the owning project/account, consultation allowance and Stop. Implementation actions remain explicit.
- Repository access and CodexWeb membership have separate status/actions. Account/machine/link removal explains the exact scope while preserving shared history.
- Compact screens use existing sheets/single-view navigation; wide screens use available space with independent scrolling. Existing keyboard, 44px targets, theme contrast and session-change draft isolation apply to every new form.

## Primary design target

Latest owner direction (2026-09-13): Tasks/Notes/Plans/Reports each use an independent window; Files and Git become separate windows rather than a combined support-pane mode. Shared projects join the same workspace shortcut row under a concise label («Общие»). Results keep project-wide scope only, with exact source backlinks. Common casing/screen/button/field primitives must cover existing and new forms, respecting each theme and the visible keyboard viewport. This supersedes older combined-pane/tab descriptions below. The first workspace-window pass and its control/palette follow-up are installed; Files/Git and project-only Results remain in the [remaining-work plan](ISSUE_AUDIT_2026-09-13.md).

Workspace shortcuts keep their earlier unframed icon/label styling. In CRT/Hi-Tech the window heading and project controls belong to the casing, above the inset screen. Project filters use a dropdown with All/unassigned choices and explicit bounded loading of more projects. Settings swatches show the actual theme material/brightness (actual accent in Organizer/Classic Dark), preserving dark matte CRT and light glossy exceptions.

**13-inch iPad, landscape, standalone PWA.**

Desktop browsers are supported, but the iPad is the reference device for layout, touch targets, scrolling and interaction design.

## Main workspace layout

Landscape uses three persistent zones:

```text
+----------------+------------------------------+-----------------------+
| NAVIGATION     |          CODEX CHAT          |      RIGHT PANE       |
|                |                              |                       |
| Projects       | clean conversation           | Results (default)     |
| Threads        | approvals                    | Files                 |
|                | prompt composer              | Activity              |
| later:         |                              | Remote                |
| Notes          |                              |                       |
| Plan           |                              |                       |
| Machines       |                              |                       |
+----------------+------------------------------+-----------------------+
```

Recommended initial proportions on the 13-inch iPad:

- Navigation: roughly 240-280 CSS px.
- Chat: approximately 45-50% of remaining width.
- Right pane: approximately 35-40% of the full viewport.

Exact sizing should be tested on-device rather than treated as a hard formula.

## Resizable/collapsible panes

- Divider between Chat and Right Pane is draggable/touch-draggable.
- Navigation can collapse to a narrow rail/icon button.
- Remember pane sizes per user/device where practical.
- Set reasonable minimum widths so panes do not become unusable.

When Navigation is collapsed, Chat + Results should gain the space rather than leaving a decorative gutter.

## Navigation

### Project-first

Top-level everyday navigation is projects.

Example:

```text
PROJECTS
  Case Maker
  AltarProject
  Reader
  Armada

THREADS — Case Maker
  UI redesign
  MCP server
  Export STEP
  + New thread
```

A project may show a small machine/status hint, but the machine should not become the primary hierarchy.

### Future global modules

Below/around projects, later add:

```text
Notes
Plan
Machines
Settings
```

Do not crowd the first implementation with empty placeholder modules.

## Chat pane

The chat is intentionally clean.

It should contain:

- user messages;
- assistant messages;
- concise turn state;
- approval prompts when required;
- small links/chips such as `2 results` or `4 files changed` that navigate the right pane.

It should generally **not** contain:

- giant screenshots;
- full diffs;
- build logs;
- raw shell output;
- every tool invocation.

Those belong in Results/Activity.

## Prompt composer

Composer is fixed to the bottom of the Chat pane, not the entire page.

Requirements:

- multiline input;
- send button large enough for touch;
- attach/image/file support can come later;
- `Cmd+Enter` sends when a hardware keyboard is attached;
- Enter behavior should be predictable and configurable if needed;
- active turn supports a clear Stop/Interrupt action.

### iPad software keyboard

Use `visualViewport`/modern viewport handling so the composer stays visible above the software keyboard.

Do not rely only on `100vh`; standalone Safari/PWA keyboard behavior must be tested on the actual iPad.

## Right pane modes

Tabs/modes:

```text
Results | Files | Activity | Remote
```

`Results` is the default.

Files and Activity may be implemented after the first working Results feed, but the pane architecture should allow them.

## Results feed

Results is a chronological visual stream associated with the active thread/project.

Example:

```text
TODAY

[ Screenshot / generated image ]
23:41  after turn 31

✓ Build passed
23:42

Δ 4 files changed   +126 -43
[Open diff]

[ CAD preview ]
23:44
```

### Result card types

Initial useful types:

- image/screenshot;
- artifact/file;
- build/check result;
- diff summary;
- preview link;
- important error.

Result cards can be compact or visual depending on type.

### Linking chat <-> results

A Result should reference its originating turn when known.

Desired interaction:

- tap `2 results` on a chat message -> Right Pane switches to Results and scrolls to those cards;
- tap `from turn 31` on a Result -> Chat scrolls/highlights the corresponding turn.

## Image viewer

Tapping an image opens an immersive viewer:

- pinch to zoom;
- pan;
- swipe/next-previous among nearby image results where natural;
- close gesture/button;
- no loss of underlying chat/results scroll state.

## Activity

Activity is the verbose operational stream:

- file reads/writes;
- commands;
- tool calls;
- MCP calls;
- detailed build output;
- connection/reconnect diagnostics.

Activity should be filterable/collapsible later. It is not the default screen.

## Files

Files is a lightweight project view, not a browser IDE.

Potential later capabilities:

- changed files;
- tree/navigation;
- preview/read-only text;
- download/open generated files;
- Git status integration.

Do not implement a full source editor before it is clearly useful.

## Remote

Selecting Remote replaces the Results content, not the Chat pane.

```text
Navigation | Chat | Remote Desktop
```

Provide an expand/fullscreen control for Remote.

When expanded, retain an obvious route back to Codex.

See `REMOTE_DESKTOP.md` for input behavior.

## Scrolling

There is no giant page-level scroll.

Each zone owns its scroll:

- Navigation scroll;
- Chat scroll;
- Results/Activity scroll.

The root application should remain viewport-sized.

## Touch rules

- No hover-only functionality.
- Important tap targets approximately 44pt or larger.
- Dividers need a larger invisible touch hit area than their visible line.
- Avoid tiny icon-only controls without enough hit area.
- Context menus must also be reachable by tap/long-press or explicit `...` button.

## Hardware keyboard and pointer

The iPad may use a Magic Keyboard/mouse/trackpad.

Useful shortcuts:

- `Cmd+Enter` — send prompt;
- `Cmd+K` — project/thread switcher;
- `Esc` — close modal/viewer/cancel transient UI where appropriate.

Do not depend on keyboard shortcuts for core functionality.

Pointer hover can add affordances but never reveal the only way to perform an action.

## Portrait mode

Do not squeeze three columns.

Use a single primary content pane with navigation drawer and mode tabs, for example:

```text
[menu] Case Maker          online

Chat | Results | Remote

<selected content>
```

Portrait is supported but not the design reference.

## PWA behavior

The application should be installable to the Home Screen and feel app-like.

Requirements:

- web app manifest;
- standalone display mode;
- application icon/splash metadata;
- safe-area insets;
- theme/background colors per current theme where practical;
- preserve login/session appropriately;
- reconnect cleanly after iPad suspends the PWA.

Do not assume a WebSocket survives backgrounding. Reconnect is normal behavior.

## Connection states

The UI should clearly distinguish:

- Hub online;
- target machine online/offline;
- Codex connecting/ready/busy/error;
- Remote available/unavailable.

Avoid modal spam for transient reconnects. A compact status indicator plus actionable error details is preferable.

## Themes

All themes share the same information architecture.

### Organizer

Intent: digital organizer / technical notebook, not antique parchment.

- clean warm/light page surfaces;
- tabs/dividers;
- subtle paper depth;
- cards feel attached/organized;
- readable contemporary typography.

### CRT Green

Intent: old green terminal displayed through a physical curved CRT device.

- dark housing/panels;
- phosphor green;
- subtle curved-screen/glass effect;
- restrained scanlines/vignette/glow;
- text itself remains crisp and accessible;
- provide reduced-effects mode if needed for performance/readability.

### Hi-Tech 2000s

Intent: expensive technical/scientific workstation from roughly early/mid 2000s, not generic cyberpunk.

- recessed displays;
- metallic/technical panels;
- blue/cyan LCD/VFD-like accents;
- physical-looking tabs/indicators;
- dense enough to feel like equipment while preserving workspace area.

## Theme implementation

Use semantic tokens, e.g.:

```css
--surface-root
--surface-panel
--surface-raised
--surface-inset
--text-primary
--text-secondary
--border-primary
--accent
--success
--warning
--danger
--shadow-panel
--radius-panel
--font-ui
--font-mono
```

Theme-specific decorative pseudo-elements/layers are allowed.

Do not duplicate business components per theme.

## Density

Support at least one comfortable touch density. A later `Compact` density for desktop can reduce spacing/text sizes, but desktop density must not compromise the iPad default.

## Performance

The iPad should remain smooth with long chats/results.

Plan for:

- virtualized long lists if necessary;
- lazy image loading/thumbnails;
- avoid expensive full-screen CSS filters on every frame;
- pause/reduce animated theme effects when app is backgrounded;
- preserve scroll anchors during streaming.

### Classic Dark and CRT refinement

Classic Dark is a fourth shared theme: graphite backgrounds, clear surface levels, soft blue-gray selection and Roboto Condensed. It has no hardware decoration. CRT uses IBM Plex Mono, phosphor text/edge glow and static raster/glass backgrounds. Photos and Remote remain unfiltered; code and input text stay crisp without glow. Increased contrast removes the raster/text glow. No flicker or scanline animation is used.

The selected theme is persisted to Hub preferences and cached for login/loading. Safari/browser theme-color follows the selection. Switching a theme preserves the active chat, draft, scroll and workspace mode.

Hi-Tech uses a neutral silver chassis, dark panel seams, inset pale screens and beveled cyan controls from the owner reference. Organizer keeps clean light paper, oval binder rings, pastel tabs and blue user avatars. Both reduce decorative edges on compact layouts without changing touch targets or workspace structure.

## Notes and saved references

“Заметки и ссылки” in both sidebars opens project context by default, with Global/All scopes. iPhone uses a full-width list or editor; iPad shows a list beside a spacious editor. Markdown preview shares collapsed copyable blocks. Save is explicit, local drafts survive panel closure/reload, and concurrent changes offer a reviewable conflict rather than overwriting silently. Result cards expose a reference action; new notes can link to the current chat/result without copying large content. Saved references use the existing three-item collapsible pinned panel. Removing a referenced source leaves the note intact and an unavailable link.

## Tasks

Both sidebars expose “Задачи”, opening the global reminder list. Single-tap filters select All, No project or an individual Codex/GPT project; Project Home opens the same data filtered to its project. Project choices use Hub metadata and remain available independently of the visible task page. Archived or missing projects retain their tasks with a status label. The compact list filters open/today/doing/blocked/completed tasks and offers one-tap completion/reopen. A spacious editor shares Notes’ Markdown, safe drafts and conflict handling, with status, priority and an optional date. On phones the date gets its own row so the day/month/year remains readable. Result reference actions can switch from Notes to Tasks and create a linked task without copying output. Generic pinned references can reopen either module.

## Project overview

The project title and an entry inside each expanded project open its overview. Project expansion and inline chat navigation remain intact. A confirmed empty Codex project gets an overview with New conversation instead of a blank chat. Continue, Tasks, recent Results, pinned context and cached machine/Git state link back to their real modules. iPhone uses one vertical feed above the existing three tabs; iPad keeps the left navigation beside a spacious main view.

The chat remains mounted with its draft, while read receipts/presence are suppressed when Home covers it. Opening a Result from Home does not briefly acknowledge an unseen phone chat. Empty-project selection stores an explicit null thread preference, preventing a previously selected project’s thread from reappearing on reload.


Assistant messages expose a speaker icon next to Copy. During reading it becomes Pause (then Resume), with a separate Stop icon; all targets remain 44px. Read-aloud belongs to the current device and stops when leaving the chat or opening another workspace view. Unavailable local voices disable the action; synthesis failures are shown beside the control without changing the chat, draft or run.


GPT navigation keeps the pinned panel first as requested by the owner on 2026-09-08. Unpinned active chats lead the ordinary group below it; pending new sends use the same area. A running pinned chat remains inside its panel. Search, the three-item fold, native pin actions and Codex activity-first ordering remain available.


A Codex project containing one visible chat is a direct chat shortcut, without a redundant chevron or nested single-item list. Its project menu puts New chat first. Creating a second chat restores expansion in place. An initial unknown group may resolve its single chat on the same tap; stale loads cannot take navigation away from a newer selection or a closed drawer.

The single hidden child keeps its own Pin/Rename/Archive/Delete actions under a named Chat entry in the project menu. The nested menu retains a snapshot of the selected chat identity: background list changes cannot retarget a chat confirmation to the project.


Read-aloud mode is an explicit device-local choice in Settings: System voice (the default when supported) or Background audio. System voice uses only the installed browser/device voices and never calls the speech API. Background audio keeps the private Piper track and Media Session controls. Changing mode stops both engines before starting any later playback. The unsupported system option is disabled; an available background worker never silently overrides a supported system voice preference.
