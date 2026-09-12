# Linked Codex projects

Project Overview contains **Связанные проекты**. Create an explicit one-way or two-way link, set its round limit (1–10), and confirm each project's Current Chat. A request waits for that chat's work and native queue to finish. It never takes desktop ownership or creates/replaces Current Chat.

One round is a question to the target and its answer returned to the source. A source evaluation does not consume another round. Either side can return a structured `resolved` decision, ending the exchange early. The final answer returns once; it cannot restart ping-pong. `needs_owner`, exhausted limits, disabled links and unknown submissions pause the exchange. The owner can stop it without interrupting an already-running native turn; late answers remain readable. Explicit continuation grants another bounded allowance.

Consultations use native read-only sandbox policy with approval escalation disabled. They retain the selected model/effort without replacing the owner's normal thread settings. Work requests prepare a draft Plan only; ordinary explicit execution and Review handle changes. Inputs, replies and source identities are bounded, durable Hub metadata; source files, Core and entire chat histories are not copied.

The `project_relays` native function lists only owner-linked projects and proposes requests. Automatic consultations require the link's explicit trust setting. Relay turns cannot create child roots to bypass their shared budget. The installed App Server accepts dynamic tools only at `thread/start`, so this function is available in newly created web chats. Existing native chats still support owner-created exchanges and structured decisions; they are never silently rotated to obtain a tool.

Storage migration 27 adds links and relay steps. Exact native turn/message IDs and command receipts reconcile acknowledgements and final answers, including `final` and `final_answer` phases. Uncertain sends are never automatically replayed. Each dispatch rechecks the live link and confirmed Current revision immediately before submission. Request drafts and owner confirmations preserve the mounted chat workspace.

Optional GitHub mirroring is not used as transport. No GitHub token, new Windows listener, background work permission or cross-project source access is introduced.
