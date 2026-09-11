# 13-inch workspace balance

Apple lists 2752 × 2064 physical pixels for the 13-inch iPad Pro and 2732 × 2048 for the 13-inch Air. At the normal 2× display scale, landscape reference canvases are 1376 × 1032 and 1366 × 1024 CSS pixels. Browser chrome, safe areas, keyboard and window multitasking reduce the available workspace; layout follows actual available dimensions, not the device name.

Sources: [iPad Pro specifications](https://www.apple.com/ipad-pro/specs/), [iPad Air specifications](https://www.apple.com/ipad-air/specs/), [Apple layout guidance](https://developer.apple.com/design/human-interface-guidelines/layout).

## Findings and changes

- The navigation was fixed at 268px while Results took 38% of the remaining width. Refined navigation now scales from 280px to 336px. The default Results share is 34%, preserving the owner's explicit saved width and the divider. Previous layout retains its former defaults.
- At 1366 × 1024, the classic-dark reference measures navigation 280px, chat 710px, Results 369px. At 1376 × 1032: 282px, 715px, 372px. Existing theme materials can change these slightly.
- At 1920 × 1080 and 2560 × 1440 the panels expand, while conversation content is limited to 880px for reading. No zoom, font-size reduction or device-specific markup is used.
- The wide Codex Results pane repeated its active tab name in a separate heading. Remove that redundant row in the refined layout, keeping counts, scope, categories, previews and all actions. GPT retains its heading because it has no equivalent tab strip.
- The Project Overview grid coupled short and tall cards into common rows, leaving large gaps. Use a wider modal and two independent stacks: current work/tasks/plans/results, and notes/Core/reports/machine context. Both share one scroller and preserve modal close/focus and current-chat state. At narrow container widths the stacks become one column. The previous-layout checkbox retains equal card columns.
- Do not divide the right pane into two permanent scroll regions. Images, demos, files and activity benefit from the full height, especially with a keyboard open; existing categories, preview and collapse controls remain.

## Verification

Linux web build includes TypeScript checking. Chromium and WebKit checks cover both 13-inch reference sizes, 1920px and 2560px desktops, phone/tablet portrait, reduced keyboard heights, four themes, one-pixel and touch-handle divider movement, persisted manual widths, previous layout, drafts, modal source links and untouched native work. Screenshots are private ignored QA artifacts; this is not physical iPad acceptance.

Related GPT fix: status-only outbox summaries contain intentionally blank content. They are useful for activity indicators but must never render as blank user messages or empty failed-send cards. Full failed/unknown sends and attachment recovery remain available; no stored content or receipts are deleted.
