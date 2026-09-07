# Mobile / iPhone UX

The 13-inch iPad remains the primary reference device, but iPhone support is a **first-class product requirement**, not a shrunken desktop fallback.

The expected mobile use case is occasional but real: check a project, message Codex, approve/interrupt work, inspect a screenshot/result, view status, or briefly take control through Remote while away from the iPad.

## Product rule

Use the same Hub, authentication, project/thread model, result feed and themes on iPhone. Do not build a separate mobile product or separate backend.

The information architecture changes with viewport size; the feature model does not.

## Primary iPhone layout

Portrait is the default mobile orientation.

Only one main workspace pane is visible at a time:

```text
+----------------------------------+
| [menu] Case Maker       Main PC ●|
| UI redesign                      |
+----------------------------------+
|                                  |
|                                  |
|          ACTIVE VIEW             |
|                                  |
|                                  |
+----------------------------------+
| Chat     Results     Remote      |
+----------------------------------+
```

Default active view is **Chat**.

Recommended bottom navigation for the project workspace:

- Chat
- Results
- Remote

Files and Activity may live behind an overflow/action sheet initially rather than consuming permanent bottom-tab slots.

## Projects and threads

The desktop/iPad left navigation becomes a mobile sheet/drawer.

Opening the project switcher should show:

```text
Projects
  Case Maker        Main PC ●
  AltarProject      Server ●
  Reader            Main PC ●

Current project threads
  UI redesign
  MCP
  Export STEP
  + New thread
```

Requirements:

- large touch targets;
- fast switching without navigating through multiple pages;
- project machine/status can appear as a small secondary hint;
- returning from the sheet preserves Chat/Results scroll state.

A long project/thread list should scroll inside the sheet rather than the whole application page.

## Chat on iPhone

Chat is the most important mobile screen.

Keep the same clean-conversation principle as iPad:

- messages;
- turn state;
- approvals;
- small result/file-change chips;
- composer;
- Stop/Interrupt.

Do not inline large screenshots, full diffs or raw command logs into mobile chat.

### Composer and iOS keyboard

The composer must stay attached immediately above the software keyboard.

Test on real iPhone Safari and standalone PWA. Use `visualViewport` where appropriate and do not assume `100vh` remains stable while the keyboard is visible.

The composer should support:

- multiline entry;
- large Send/Stop control;
- attachments later;
- safe-area bottom inset;
- preserved draft when switching between Chat and Results where practical.

## Results on iPhone

Results becomes a full-width feed.

Cards should favor visual clarity over density:

- screenshots use nearly the available width;
- build/check state is a compact card;
- file changes summarize rather than showing a full diff inline;
- artifacts expose a clear open/download action;
- important errors are prominent.

Tapping an image opens the same immersive pinch/zoom viewer used on iPad.

Links between turns and results remain bidirectional:

- result chip in Chat -> switch to Results and focus the matching card;
- `from turn ...` in Results -> switch to Chat and focus the originating turn.

## Remote on iPhone

Do not squeeze Remote beside Chat.

Opening Remote should use the full available workspace viewport, with a compact overlay toolbar:

```text
+----------------------------------+
| < Codex    Main PC      [keys]   |
+----------------------------------+
|                                  |
|                                  |
|       REMOTE DESKTOP             |
|                                  |
|                                  |
+----------------------------------+
```

Provide easy access to:

- exit/back to Codex;
- software keyboard;
- Esc;
- Ctrl / Alt / Win helpers where supported;
- fullscreen/orientation behavior;
- touch vs trackpad-style pointer control if the chosen Remote client supports both reliably.

Remote on iPhone is for brief intervention, not prolonged desktop work. Optimize for being able to click/fix/check something quickly.

Landscape orientation may give Remote extra room, but the rest of the mobile app must remain fully usable in portrait.

## Files and Activity

On narrow mobile widths these are secondary screens.

Possible entry points:

- overflow menu in project header;
- `More` sheet;
- links from relevant result cards.

Do not permanently reserve horizontal space for them on iPhone.

## Notes / Plan / Machines later

Future platform modules should also have mobile-native presentations:

- Notes -> full-width list/editor;
- Plan -> compact task list;
- Machines -> status cards;
- project quick notes/status may be reachable from the project sheet.

Do not create miniature desktop dashboards.

## Mobile status

A compact status indicator should remain visible without wasting vertical space:

- Hub reachable;
- active target machine online/offline;
- Codex ready/busy/error.

Detailed CPU/RAM/disk information belongs in Machines/details, not the permanent mobile header.

## Navigation and gestures

Core actions must never depend on gestures alone.

Optional conveniences are fine:

- edge swipe to open project drawer if reliable;
- horizontal swipe between Chat and Results only if it does not fight text/image scrolling;
- pull-to-refresh is not required because live state uses WebSocket/reconnect.

Always provide explicit controls as the canonical path.

## PWA / Safari

Support both:

- normal Safari tab;
- Add to Home Screen / standalone PWA.

Requirements:

- safe-area support including Dynamic Island/home indicator areas;
- reconnect after browser/PWA background suspension;
- no assumption that WebSockets survive suspension;
- preserve current project/thread and active view on reconnect;
- correct viewport handling when rotating the phone;
- avoid accidental horizontal page scrolling.

## Themes on mobile

Use the same theme system and semantic tokens.

Theme decoration may be simplified on small screens:

- Organizer keeps tabs/material hierarchy without thick decorative margins;
- CRT keeps the green phosphor identity but may reduce heavy curvature/scanline effects;
- Hi-Tech 2000s keeps hardware-like panels while avoiding oversized bezels.

Functionality and information priority always beat decorative fidelity on iPhone.

## Responsive strategy

Treat layouts as deliberate modes rather than endlessly shrinking columns.

Suggested semantic modes:

- `wide-workspace`: 13-inch iPad landscape and desktop -> three-zone layout;
- `compact-workspace`: smaller tablets / portrait iPad -> drawer + one/two visible workspace panes as appropriate;
- `mobile`: iPhone-class width -> one primary view + project sheet + bottom navigation.

Use container/layout logic and actual available width rather than device-name sniffing.

## Live activity and read state

A single authenticated Hub metadata stream updates every project's and chat's badges independently of the open chat. Active tasks sort first with their start time fixed during streaming; completed unread work follows; other entries sort by latest activity. Waiting questions retain an active position and show a question icon. A failed/interrupted completion uses an attention icon on its chat instead of a success mark.

Both navigation tabs show active and unread counts. Projects counts projects with matching work, Dialogs counts standalone chats. Folder expansion alone does not acknowledge output. The Hub stores the exact completion cursor seen after the latest messages remain visible at the bottom of an unobstructed foreground Chat view for one second. Background tabs, Results/Remote on mobile and reading older history retain the badge. A stale acknowledgement cannot clear a later completion, and read state synchronizes across devices and survives Hub/browser restarts. Pre-existing historical conversations start read.

The Chat view has one expandable progress strip above the composer and a compact header indicator. Do not add a separate working/spinner row after the messages. There is no duplicate upper chat heading/status strip; the header text describes connectivity. Result events refresh the feed while a turn is still running, and older in-flight result responses cannot overwrite the newly selected chat.

## Acceptance criteria

Before calling mobile support complete, verify on a real iPhone that the user can:

1. log in;
2. select a project and thread;
3. send a prompt;
4. watch streaming output;
5. approve/deny or interrupt a turn;
6. switch to Results and inspect screenshots/artifacts;
7. jump between a result and its originating chat turn;
8. open Remote and perform a brief manual interaction;
9. background and reopen the app without losing the workflow;
10. perform all core actions without hover or a hardware keyboard.

## Initial implementation updates

The owner requested mobile-first implementation. The composer now includes model, Work/Plan mode and reasoning effort, plus file/photo selection, image preview, removal before sending, paste/drop support where available and draft attachment recovery after reload. HEIC selected through Safari is converted when that browser can decode it; otherwise the UI requests JPEG/PNG instead of silently dropping the image.

History initially shows 20 latest messages. Older pages require the explicit button and keep the scroll position stable. The mobile shell and wide view share state and semantic themes. See VERIFICATION.md for browser automation versus outstanding physical-device acceptance.

## Workflow and visual revision — 2026-09-06

Project folders now reveal their chats in the same drawer; multiple projects can remain expanded. "Диалоги" lists only unassigned chats. Sending has immediate feedback and a persistent progress/waiting strip above the composer, with a direct jump to unanswered native questions. Choice questions accept an option or an explicit custom answer; questions without options use a text field. Reopening the page restores the pending request.

An occupied desktop conversation produces a specific error rather than a Safari JSON parsing message. The draft stays in place. An explicit copy action can move completed context, draft and pending files into a new conversation; original same-ID continuation still depends on native writer release (SYNC_AND_REMOTE.md).

Roboto Condensed is bundled with Latin/Cyrillic coverage for organizer and hi-tech. CRT keeps monospace. The parameter row has smaller visible labels, native 16px pickers and at least 44px touch areas. Shared spacing reduces the header, footer and composer footprint; phone Chat omits its redundant heading. Input text stays 16px.

The screenshot audit includes login, project and standalone lists, creation/folder forms, settings, chat, Results/image viewer, Activity and Remote connection/controls in portrait, landscape and the wide workspace. Remote teardown removes only its owned canvas/input nodes and keyed branches prevent an old display from leaking onto its empty state. Detailed browser and physical-device validation boundaries are in VERIFICATION.md.

## Native activity and queued messages

Project/thread spinners now also observe desktop-owned work through D25's read-only metadata adapter. External updates arrive within the polling interval while the site is open; a browser reconnect refreshes the snapshot. Unavailable observation is visible in navigation, and uncertain work never appears as a completed success.

During a turn, Send becomes Add to queue. An independently scrolling compact queue above the composer shows pending text/files, edit, delete and Steer. Clearing the draft exposes Stop; Stop remains accessible while typing. Queue edits capture the revision opened by the editor so another device's edit cannot be silently overwritten. Each action is touch-accessible. A queued message starts automatically after the current native turn, even with the browser closed. Model/mode settings remain those of the current native conversation. Steer is available for web-owned turns; an external desktop turn can receive queued follow-ups.


### Compact workflow controls

- The compact project drawer also opens with a single-finger rightward swipe starting within 28 CSS px of the workspace's left edge. Require at least 64 px of horizontal movement; cancel vertical, leftward, slow, cancelled and multi-touch gestures. Inputs, links/buttons, overlays and Remote do not activate this gesture. The hamburger remains available.
- Keep the gesture connected after switching Codex/GPT, including a page initially opened in GPT. Opening the drawer focuses its close control, never the native client selector. Use one shared slide-in/slide-out transition with a fading backdrop; retain modal focus until closing finishes. Short tab, disclosure and panel transitions share the same motion rules across themes. Respect reduced motion and keep streaming history and Remote stationary.
- The composer has a 44 px normal/full access picker with short labels. No extra explanation of future-turn timing is displayed.
- The turn-status row opens and collapses an eight-item recent-work panel with independent scroll and a maximum 28dvh/240px height. Keep Stop reachable while composing or transferring attachments. Accepted Steer receipts remain visible until inserted into the conversation.
- Settings offers manual desktop handoff/return and a separately confirmed hard restart. Read-only navigation never silently returns a released machine to web control.

### Collapsible wide support pane

At widths of 1100 CSS pixels and above, the header provides Remote and right-pane visibility controls. Collapsing the pane gives its width to chat and preserves the selected support view. The local visibility preference survives reload; compact layouts ignore it and retain Chat / Results / Remote navigation. Opening a result or Remote explicitly reveals the pane.

History restoration must not replace newer WebSocket messages. A fresh second client receives persisted public replies and the native public summary panel while the task continues.

### Interactive design previews

HTML demo cards open a single large viewer over the workspace. The close action stays in its top toolbar; mobile fills the viewport and respects safe areas. Fit-to-width is the default, with an optional 960px canvas for designs meant for a wider display. Navigation and chat state remain mounted underneath. The demo receives no access to the surrounding app or its credentials.


### Copy controls

Codex and GPT message headers expose a small copy icon with a 44px touch target. Code/text blocks have a separate copy control available while collapsed, and Results commands/diffs can be copied independently. Copy uses the current message text or exact block contents, without interface labels. A brief check mark confirms success; a failed browser clipboard operation stays visible and allows retry. Keyboard focus, selection and composer drafts are preserved.
