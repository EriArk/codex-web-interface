# Prepare for Codex

Stage #201, 24 September 2026. The Project GPT header opens one private preparation window above the mounted conversation. Select up to eight completed public answers or describe the settled idea. The existing Project GPT envelope includes its current Project/Space context and immutable Brainstorm handoff. Selected answer bytes are not silently shortened; oversized context requires a smaller selection. Existing repository documents are read at the exact default-branch SHA and bounded excerpts are identified as excerpts for generation.

Generation uses the existing durable Project GPT outbox. It produces a proposal, not repository mutations. The user can edit documents, compare previous/new text, exclude Issues, and add local reference material. An invalid generated JSON answer remains in Project GPT and leaves an editable document draft. Closing and reopening retains account-local edits bound to package revision. Repeated creation uses the same frozen idempotency key. Existing completed packages can be reopened.

## Review and publication

- Up to 16 documentation/reference files, 96 KiB decoded total, and 10 Issues. Root Markdown/TXT plus documents and supported reference files in `docs/` or `references/`. Large references can be represented by reviewed links in reference documents; this flow does not implement arbitrary binary repository uploads.
- AGENTS.md and CODEXWEB.md cannot be written anywhere. Traversal, Windows reserved names, case aliases, parent/file collisions, noncanonical base64 and duplicate paths are rejected. Native reads verify existing path kind and SHA. Replacements bind the reviewed blob. Keep both by choosing a different name; save validates the new destination. Skip is explicit.
- Save, review and publish are separate. The confirmation identifies repository, actual numeric GitHub account, destination strategy and Issues count. Native access and project/machine/Space/binding scope are rechecked between asynchronous boundaries.
- Nonempty repositories use `codexweb/prepare/<package UUID>`, one atomic expected-head commit through GitHub `createCommitOnBranch`, then a PR to the observed default branch. No local working files or checkout branch change. An empty repository receives its first document through Contents API, then any remaining files in one expected-head commit. Shared `collaborate` access cannot initialize the default branch; a direct-access participant must initialize it.
- Initial Issues use the existing Issue Drawer publisher. Before its confirmation, the coordinator compares every title/body, project, repository ID and numeric acting account against the reviewed package. No second Issue publisher or arbitrary AI-write endpoint is introduced. Generic shared GitHub operations cannot invoke preparation mutations.

## Recovery and handoff

Each native step stores its exact intent and operation UUID before preparation, then a sent flag before dispatch. A restart pauses execution and never automatically replays writes. Status only reconciles receipts; explicit continuation performs remaining steps. Unknown outcomes retain the original key. A known rejected step can receive a new receipt on explicit continuation, keeping prior receipts and limiting attempts. Identity/repository changes and moved heads invalidate the operation rather than overwrite them. Issues retain the existing Drawer recovery and explicit retry controls. Changed Issue content cannot satisfy the original package.

Generation, dispatch and uncertain native operations participate in existing maintenance admission. Idle-only Windows helper replacement includes backup, hash verification and an actual Hub → SSH → Scheduled Task read probe. The additive private `project_preparations` table is included in normal database checkpoints; it does not change the public schema version.

The result opens PR/commit inspection inside the app. “Open plan in Codex” creates/reopens one private Project plan containing the exact branch, commit, documents and published Issues. It opens that same Project without submitting a Codex turn. Switching/merging the working copy and starting implementation remain explicit subsequent work; user drafts and active tasks are preserved.

## Verification

Focused coordinator tests cover publication ordering, exact collisions and revisions, wrong identity, stale head, uncertain acknowledgements, restart, cancellation and principal-private routes. Native worker tests cover atomic commits, empty repository initialization, case/policy/path rejection, lost-ack reconciliation and no replay. Existing Issue Drawer and Project GPT tests cover their reused publisher/outbox. Chromium and WebKit exercise the actual app, draft reopening, confirmation, publication and plan handoff. Phone, keyboard-height phone, compact/wide tablet screenshots use all four themes. Physical-device acceptance remains pending owner use.

API design references: [Git database and empty repositories](https://docs.github.com/en/rest/guides/using-the-rest-api-to-interact-with-your-git-database), [commit mutations](https://docs.github.com/en/graphql/reference/commits), [file changes](https://docs.github.com/en/graphql/reference/git), [Contents API](https://docs.github.com/en/rest/repos/contents).
