# In-app user guide — 24 September 2026

Settings' question mark opens the complete catalog. File/editor help buttons and
F1 retain contextual articles; Settings F1 opens the catalog. Remote and terminal
surfaces continue to own F1. No tour, external documentation site or native send
is introduced by opening help.

`apps/web/src/helpContent.ts` contains 53 plain-text articles in 11 categories,
with subcategories, sections, ordered instructions, related links and search
keywords. Six end-to-end examples cover development, file editing/merging,
brainstorm-to-project, team access, GPT research/sharing and direct GitHub edits.
The guide also covers project profiles/Core/preparation, Codex settings/queue/
schedules, GPT recovery, Results, all viewer families, file operations/recovery,
Space Write access, messenger, voice, Activity, Notes/Tasks and maintenance.

Source verification: FILE_EDITOR.md (including latest amendments), FILE_VIEWERS.md,
PROJECT_AGENT_PROFILES.md, PROJECT_PREPARATION.md, CODEX_SCHEDULES.md, WORKSPACE.md,
COLLABORATION_SPACES.md, SPACE_GITHUB_WRITE.md, SPACE_ACTIVITY.md, COMMUNICATION.md,
BRAINSTORM.md; current SettingsSections, file preview registry, technical viewer
controls, composer and recovery implementations. Older historical limits/rules in
these documents do not supersede current owner instructions or implementation.

The wide reader has independently scrolling catalog and article. Below 800 CSS
pixels, catalog/search results and article form reversible single-screen views.
Article history retains reading position within the open window. Related articles,
section jumps and full-text search stay inside the same dialog. Search is local,
case-insensitive, normalizes ё/е and requires every query word. A blank query
restores the hierarchy; no-match has a reset action. Merely opening the catalog
must not focus the search field and summon the phone keyboard.

Maintenance: edit the relevant article alongside a workflow change; include what
the action changes, its confirmation/recovery behavior, and an example where
helpful. Use exact supported labels and distinguish feature limitations from
transfer limits. Keep stable article IDs, real related links and the category list
complete. Do not promise unimplemented converters, archive editing or Office/CAD
editor fidelity. The guide never exposes private runtime data or credentials.

Verification: content tests validate stable contextual entry points, hierarchy,
related targets and Cyrillic full-text search. Chromium/WebKit exercise the actual
Settings question mark, nested viewer/F1, parent focus/draft restoration, category
and subcategory navigation, search/reset/empty results, section jumps, related
links/back scroll, and detailed workflows. Four themes at phone, keyboard phone,
compact tablet and wide sizes receive screenshot inspection. Physical-device
acceptance remains pending. No Hub or installed PC helper contract changes.
