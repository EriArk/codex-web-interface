# Earned Codex resets (#129)

Settings shows native earned reset credits below the existing limits. This is not purchased usage or a billing balance. A user selects a currently available credit (or “use one” when Codex provides only a count) and confirms explicitly. Count, native title/description and expiry are bounded for display. Unsupported, unknown, expired and already-used details are never made actionable.

The Hub calls `account/rateLimitResetCredit/consume` through the configured machine's existing App Server connection. It does not load a chat, change access, transfer ownership or restart the desktop. The request uses a durable UUID as the native idempotency key. Account identity is private and hashed; snapshot revision/fingerprint and an account-wide reservation reject stale or simultaneous requests from another device/machine.

Schema 26 stores account revisions and operation receipts. Pending operations become unknown after Hub restart or backup restore. Reloading a page observes the existing receipt; only explicit “check attempt” may repeat the original native call with its original key and credit. A lower count or changed percentage never proves that our attempt succeeded. Switching accounts cannot retry another account's operation.

Native outcomes are `reset`, `alreadyRedeemed`, `nothingToReset` and `noCredit`. The first two confirm this operation; the following canonical read supplies the actual windows and remaining credits. No optimistic quota calculation or automatic redemption is used. Legacy Codex without credits retains the existing limits view.

Verification: portable route/storage/normalization tests cover auth/CSRF, exact retries, stale screens, concurrency, unknown receipts, account changes, expiration, count-only responses and unsupported versions. Browser tests use an isolated Hub and simulated native account; Chromium/WebKit cover phone/tablet, four themes, confirmation/cancel, canonical refresh, drafts and lost acknowledgements/reload. Backup testing retains receipt identity while changing pending to unknown. No owner's real reset credit is spent; physical iPhone/iPad acceptance remains the owner's usage check.

See [earned-reset protocol](https://learn.chatgpt.com/docs/app-server#8-earned-rate-limit-resets-chatgpt).
