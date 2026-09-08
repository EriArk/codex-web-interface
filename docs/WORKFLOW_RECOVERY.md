# Workflow recovery

Codex and GPT retain a pending send receipt in the same-tab session storage alongside the draft. The receipt contains the exact request signature and its original idempotency key. Explicit retry after a lost HTTP acknowledgement or a reload uses that key; the Hub returns the original receipt/job or preserves an unknown native outcome without dispatching again. Changing the request represents a new submission. Acknowledged receipts are removed only after the composer persists its new or empty draft, avoiding a reload gap between acknowledgement and draft cleanup. Ending the private session clears these receipts. If the browser cannot persist a new receipt, the request is not sent.

The authenticated API client bounds both response headers and body consumption. Reads default to 30 seconds, writes to 135 seconds, and raw uploads to 180 seconds. GPT job polling uses a 15-second deadline and cancels reads belonging to an unmounted selection. Visibility, pageshow and online events can resume reads. A timed-out write is not automatically retried; its saved receipt remains available for explicit reconciliation. No authentication step, model capability or native workflow is removed.

The lazily loaded GPT workspace has a local error boundary. If its JS chunk is unavailable, the current page offers Refresh or Return to Codex instead of leaving an empty root. Refresh is explicit, so a persistent module/network failure cannot cause a reload loop. This does not add indefinite hosting of old builds; the fallback is also needed for ordinary failed asset requests.

Bridge artifact downloads check stored artifact ownership independently of the last-100-jobs sidebar/status window. Results belonging only to deleted conversations/outbox entries and unknown artifact IDs remain inaccessible. Native sandbox-file downloads retain their separate current-branch verification.

## Regression checks

- `tests/gpt-reliability.browser.mjs`: lost acknowledgement, reload, original receipt reuse, bounded stuck polling, write timeout without automatic replay, and explicit retry. Chromium and WebKit, isolated account-free fixture.
- `tests/reliability-codex.browser.mjs`: actual authenticated Hub, lost HTTP acknowledgement, completed native turn, reload and explicit resend; exactly one native `turn/start`. Windows process effects are simulated.
- `tests/gpt-load.browser.mjs`: missing lazy chunk produces actionable recovery; returning to Codex works without an uncaught error.
- `tests/gpt-result-retention.test.mjs`: old bridge result survives 100 newer jobs; unknown/deleted results stay blocked; existing send receipts remain readable while library mutation is busy.

All are included in CI. Physical iPhone/iPad verification remains the owner's normal use; browser-engine fixtures are not a claim of separate hardware acceptance.
