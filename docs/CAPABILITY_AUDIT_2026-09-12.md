# Remaining web-client functionality — 2026-09-12

Initial review: source `af078b4`, the current GitHub issue/PR lists, the previous capability audit and the locally saved generated Codex protocol schema. The initial review below describes the gaps before implementation; its implementation follow-up is recorded at the end. Presence in a saved native schema is evidence for implementation planning, not a promise that every account enables the feature.

## GitHub backlog

There are five open issues and no open PRs at the time of this review:

- [#37](https://github.com/EriArk/codex-web-interface/issues/37): additional Codex execution machines, including remote Linux/Tailnet. This remains owner-deferred; the existing PC/server device terminals are a separate feature. A real second execution-machine installation is required before broad support can be claimed.
- [#6](https://github.com/EriArk/codex-web-interface/issues/6): allowed project roots. Explicitly owner-deferred; do not silently restrict the existing folder workflow.
- [#10](https://github.com/EriArk/codex-web-interface/issues/10): physical iPhone/iPad acceptance through everyday owner usage, not a missing application module.
- [#11](https://github.com/EriArk/codex-web-interface/issues/11): guided installation for other people. Explicitly deferred by the owner on 2026-09-12; current development serves the personal installation.
- [#14](https://github.com/EriArk/codex-web-interface/issues/14): umbrella stabilization/distribution tracker. Its distribution work is explicitly deferred; personal reliability remains relevant. Several historical unchecked references are stale: storage #5, workspace #83–#89 and speech #90 are closed. GitHub Actions are explicitly out of scope under the current owner instruction.

The ordinary feature gaps below are mostly absent from those open issues. The old tracker alone is therefore not an adequate implementation backlog.

## Already implemented since the previous capability audit

- Standard MCP typed forms and URL requests, including accept/decline/cancel and receipt protection: [elicitation parser](../apps/hub/src/elicitation.ts), [UI](../apps/web/src/ElicitationCard.tsx). Extended OpenAI forms/unknown constraints remain explicitly unsupported.
- Native account-backed dictation in both composers, waveform/timer and second-tap submission: [dictation](DICTATION.md). This is not two-way voice conversation.
- Earned usage resets, explicit zero state and guarded redemption: [#129](https://github.com/EriArk/codex-web-interface/issues/129), [reset documentation](USAGE_RESETS.md).
- Bounded linked-project consultations, per-link depth and early resolution: [#128](https://github.com/EriArk/codex-web-interface/issues/128), [relays](PROJECT_RELAYS.md). Native relay tools are available on newly created web chats; existing chats are not silently rotated.
- Independent compatible web publication, with persistent execution engine and visible maintenance state: [#132](https://github.com/EriArk/codex-web-interface/issues/132), [deployment](INDEPENDENT_DEPLOYMENTS.md).
- Completed-command output can be expanded and copied. It already has a truncation notice; the previous audit's statement that this notice is missing is obsolete: [CommandOutput](../apps/web/src/CommandOutput.tsx).
- Codex fork, Files/Git/README/releases, device terminals, Notes/Tasks/Plans/Reports/Core, capture, review, delivery and configured GUI previews are existing features, not fresh backlog items.

## Priority 1: preserve information and expose ongoing work

### 1. Preserve unsupported visible GPT content

[gptHistory](../apps/hub/src/gpt-history.ts) discards messages outside `text`/`multimodal_text`, and only understands strings and image pointers within multimodal parts. A visible native audio/video/other structured item can disappear entirely from the primary chat.

First retain a safe, source-bound placeholder with an explicit action to open the original conversation; then support formats with verified native contracts. Continue excluding hidden analysis, tool internals and private signed URLs. Mixed supported/unsupported parts must retain the supported text and indicate the remaining content.

### 2. Stream Codex command output

[Sessions](../apps/hub/src/sessions.ts) emits command metadata at start but stores `aggregatedOutput` only on completion. It does not consume `item/commandExecution/outputDelta`. The separate device terminal is live, but is not the output of Codex's running build/test.

Add bounded live output to the existing Activity/Results disclosure, preserving item/thread/turn identity, reconnect and scroll position. Prefer a useful tail and explicit limits. The existing [output endpoint](../apps/hub/src/command-output.ts) serves only the first 64,000 saved characters; its truncation warning does not recover discarded bytes. Downloadable longer logs need their own bounded storage policy.

### 3. Native progress, context usage and combined changes

The event adapter does not project `turn/plan/updated`, `thread/tokenUsage/updated` or `turn/diff/updated`. Public reasoning summaries and textual plan items already work.

Expose a compact native step checklist, context usage when known and a single turn-level changes view. Keep these distinct from the owner's saved executable Plans. Missing context capacity must show unknown, not a guessed percentage; an aggregate diff must not double-count per-file results.

### 4. Refresh limits from native account events

The notification handler resolves a thread before doing any dispatch and returns for account-only events. `account/rateLimits/updated` therefore does not refresh the UI. [UsageLimits](../apps/web/src/UsageLimits.tsx) polls while Settings is visible every 60 seconds and reacts to local reset redemption.

Handle account events at machine/account scope before thread lookup and invalidate/refetch the canonical limits snapshot. Do not interpret a sparse event as clearing earlier known account data, or confuse token context usage with account quotas.

## Priority 2: remove routine trips to the original GPT UI

### 5. GPT editing, regeneration and answer branches

Canonical history follows `current_node`, while the primary [GPT API](../apps/hub/src/gpt.ts) has no edit/regenerate/select-branch operations. Add branch identities/navigation first, then explicit native editing and regeneration with the existing exact-send/unknown-outcome protections. Codex's existing fork action is separate and must remain available.

### 6. Native GPT project instructions and files

The native project projection contains ID/name, not an instruction/file editor. The owner's Hub Project Core is separate data. Expose native project instructions and files explicitly, without silently copying or replacing Core. Verify the browser/native operations on a disposable project before promising production parity.

### 7. Desktop-hosted tools and capability visibility

The dynamic-tool path supports workspace-dependency lookup and the explicitly registered project relay; other desktop-hosted tools return an unsupported result. Standard native CLI/MCP tools are not globally disabled.

Inventory actual rejected tool names and add useful integrations individually. A read-only skills/plugins/MCP availability screen would help distinguish unavailable configuration from unsupported web hosting; matching list methods exist in the saved native schema but are not wired into the Hub UI. Do not implement a generic raw RPC/desktop-control bridge. Extended MCP forms remain a separate compatibility task.

## Further product options, not completion blockers

- Search within old conversation content and across saved workspace items. Sidebar title filtering and module-local searches exist; a unified content search does not. Index only explicitly chosen Hub/native-visible data, preserving bounded history loading.
- Native Canvas editing, two-way voice and ChatGPT scheduled-task management still require separate integrations. HTML demos, dictation/read-aloud and human Tasks do not implement those features. Availability in the original account and a reliable native integration must be established first; do not substitute an unrelated engine or claim parity from a mock UI.

## Recommended implementation sequence

First complete items 1–4 as focused changes: preserve GPT content, live command output, structured progress/context/diff and account updates. Then implement GPT branch navigation/editing and native project settings/files. Triage desktop tools from actual failures alongside that work. Additional execution machines remain deferred. Installers, transfer to other people and distribution-specific work are excluded until the owner explicitly resumes that direction. Canvas/full voice and automation remain separate features to assess for personal use.

Validation for implementation should cover reconnect/late events, independent chats and machines, exact mutation retries, unsupported formats, bounds/truncation and the shared phone/tablet shell. This review itself required no deployment or functional changes.

## Implementation follow-up

The personal-workflow pass implements priorities 1–7 and content search. See [Native work and GPT actions](NATIVE_WORK.md) for the contracts, limits and access points. Specifically, command output streams into a bounded retained log; native plan/context/diff and machine-scoped quota refresh are exposed; unsupported visible GPT formats keep a source link; native GPT editing/regeneration/version continuation and project instructions/files use durable receipts; Skills/Plugins/MCP availability and content search are available in the shared UI.

The read-only production inventory found no rejected desktop-hosted tool names to implement individually. The availability screen reports actual native list failures independently, rather than claiming that every installed desktop integration is hosted by this web client. Extended OpenAI-specific forms and future dynamic tools still require a verified contract for each integration.

Native Canvas editing, two-way voice and scheduled automation management are **not implemented by this pass**. The native voice control was observed, but the current consumer browser connector has no verified duplex-audio transport. The saved App Server/CLI contract also does not expose the native scheduled-task management UI. Dictation, read-aloud, HTML demos and human Tasks remain separate features; they are not substitutes. These native features remain accessible in the protected original interface while their integrations need separate design and validation. References: [native voice](https://learn.chatgpt.com/docs/features/voice), [native automations](https://learn.chatgpt.com/docs/automations).

Issue recheck found the same five open issues and no new functional issue. #6 and #37 retain their earlier explicit deferrals; #10 continues through owner hardware usage. #11 and the distribution portion of #14 are excluded by the owner's personal-installation instruction. No GitHub Actions, public Windows listener, installer, credential transfer or desktop interruption was added.
