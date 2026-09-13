# Native Plan → Work (#165)

## Installed native contract

Read-only inspection on 2026-09-13 used the installed Windows package `OpenAI.Codex_26.908.4834.0_x64__2p2nqsd0c76g0`, `codex-cli 0.153.4`, and its generated App Server TypeScript schema. The inspected `app.asar` SHA-256 was `2bd5b96a48232f3ccf3df6be50965920699ea3a1b4512dcdd770e209fd1f009e`.

`v2/ThreadItem.ts` includes a structured `plan` item with ID and text. `ServerRequest.ts` does **not** define `item/plan/requestImplementation`. The desktop main process synthesizes that UI request after a successfully completed turn containing a nonempty structured plan. It is not an App Server RPC the Hub can call.

In the packaged `app-primary-17b54400f32a.js`, `Bcr` removes the local request, selects `default` collaboration mode, and sends a normal follow-up containing the exact plan. The prefix constant exported from `app-initial-d9bed9d614d8.js` is `PLEASE IMPLEMENT THIS PLAN:` followed by a newline. CodexWeb mirrors that ordinary turn behavior with current model/effort/access; it does not invent a separate implementation RPC or route the request through saved Workspace Plans.

## Candidate behavior

The action appears beside the last eligible structured plan after confirmed successful completion in native Plan mode. A prose checklist is insufficient. Failed/interrupted/unknown turns and Work-mode turns do not qualify. Old imported plans without retained mode evidence are explicitly unavailable; no mode is inferred from assistant prose.

The review fingerprint binds native thread/turn/item/exact text, local project/machine/working directory, Current Chat revision and settings. Immediately before ordinary `turn/start`, under the existing project writer lock, a bounded canonical latest-turn read must confirm the same completed plan and an empty native queue. Busy/queued work requires waiting and reviewing the resulting context. Current Chat or settings changes invalidate an old button.

One durable receipt per exact native plan prevents double activation across tabs and request keys. The implementation has a stable native client-message ID. Lost acknowledgement remains uncertain; explicit checking confirms only an exact canonical client ID **and** exact submitted text. An absent match never authorizes replay. Existing ownership/access checks remain; this action never closes the native desktop automatically.

Draft text and pending attachments are not passed to the plan action. The composer remains available with its existing contents. Starting switches only the actual conversation execution to Work. Phone/tablet rendering uses the shared result-action control and themes.
