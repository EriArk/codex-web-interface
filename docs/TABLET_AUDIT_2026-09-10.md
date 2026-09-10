# Tablet audit and shared theme refinement

Scope: Codex/GPT tablet panes, Settings, Tasks, Notes, Plans, Reports, Core,
project overview and Files/Git. The owner's drawings remain the visual reference.
Native conversation ownership and execution contracts are unchanged.

## Findings addressed

| Finding | Result |
| --- | --- |
| About 35 newer CSS rules referenced `--radius`, but that token was undefined. | Shared radius and material tokens give each theme consistent cards, fields, tabs and selection. |
| The result divider measured the whole window instead of the content area excluding navigation. A one-pixel drag could shrink the pane by about 81 pixels. | Measure the content area, preserve the grab offset and persist keyboard resizing. The visible seven-pixel separator has a larger central touch handle. |
| Scrolling Settings moved its close button outside the viewport. | A persistent heading keeps the unframed close control reachable in both clients. |
| Long source captions overflowed Notes actions. | Separate the action and caption; ellipsize the caption while retaining its full accessible name. |
| New modules inherited colors but little of the theme's materials. | Paper and divider details for Organizer; recessed displays and metal controls for Hi-Tech; background raster and phosphor glow for CRT. Classic Dark retains its graphite treatment. |
| Tall tablet chrome consumed space while typing. | Refined navigation is 268px instead of 295px, with a 60px header. Keyboard layouts compact the shortcut row and keep dialogs within the available viewport. |
| GPT chats outside projects had a dimmed identity because their overview action was disabled. | Keep the non-actionable chat identity readable. |

## Owner controls

Codex/GPT Settings share a theme picker and device-local “Прежняя компоновка”
checkbox restoring previous pane/chrome proportions and editor spacing. Changing
it preserves selection, drafts and native work. Functional repairs and materials
apply in either layout.

CRT means screen atmosphere, not a monitor body: no thick border in either layout.
Raster stays behind content, text remains crisp, media retains its colors and
contrast preferences disable glow. There are no animated screen filters or
theme-specific functional implementations.

## Verification and limits

`tests/tablet-themes.browser.mjs` uses an isolated Hub and compiled UI in Chromium
and WebKit. It checks one-pixel and extended-handle resizing, keyboard persistence,
layout choice across reload/client switching, sticky close controls, source
captions, preserved chat/note drafts and absence of native turn mutations.

Screenshots cover all four themes in both clients at 1366×1024 and 393×852, plus
Notes at 1024×1366, 820×1180, 744×1024 and reduced keyboard heights. Existing
regression suites cover Files/Git, project modules, downloads, navigation and
Remote. Synthetic screenshots stay in ignored `.local/qa-tablet-themes/` and
`.local/qa-project-inspector/` directories.

Headless WebKit can batch viewport-change events. Layout tests explicitly deliver
a resize event after changing their emulated viewport. This is not evidence of a
physical-device rotation bug. Actual iPad keyboard/rotation and iPhone PWA behavior
remain the owner's on-device usage check.
