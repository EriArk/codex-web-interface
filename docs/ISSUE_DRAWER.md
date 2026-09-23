# Issue Drawer — reviewed publication

Implemented on 23 September 2026 for #211, following [Project Intake](PROJECT_INTAKE.md). Ordinary GPT discussion remains unrestricted. Collection is an explicit user action; no semantic extraction or automatic publication is performed.

## Workflow

Completed public GPT answers and Intake answers offer **В Issues**, including individual fenced blocks. Collection verifies the exact canonical message and selected byte-preserving string range. The private drawer retains the original source, range, timestamp and text separately from the editable title/body. It opens above the mounted conversation. Both the whole answer and individual blocks can be collected; changing a selection or editing a draft does not change the source message.

**Подборка Issues** is also available in Project overview, Project GPT and Intake. Users choose their own project checkouts, edit drafts, reorder or remove them and select up to 20 items from multiple repositories. Text is limited to the existing worker's 16,000-character body and 200-character title contract. The initial title is the first nonblank line, mechanically stripped of a Markdown heading marker; the body is unchanged. Nothing invents an Issue title or rewrites its content after approval.

**Проверить пакет** verifies each target through that user's machine-local GitHub worker and freezes the exact title/body, project, repository numeric identity and authenticated GitHub identity. The package groups entries by project/repository and shows the actual publisher and item count. Only **Отправить N Issues** authorizes publication. Failed preparations remain individually editable. Successful entries get separate receipts and open in the existing integrated GitHub viewer. The original canonical message opens in a private source window; the selected original text remains stored even if the native branch later changes.

The dispatcher is a hidden, operation-scoped `codex/dispatcher` binding and a fixed typed worker. It does **not** create an additional LLM conversation or make the dispatcher a project memory. It invokes the established `githubWorkProbe` prepare/apply/status protocol under the sender's checkout and GitHub account. No arbitrary shell, browser publication or owner-account fallback is introduced. Labels and assignees are intentionally not exposed in this slice.

## Durability and isolation

- Drafts and package receipts live in each principal's private Hub database. Browser edit buffers and capture/package retry keys use account-local storage and clear with the account. Editing uses an expected revision. Duplicate capture, prepare and confirm acknowledgements reuse exact durable IDs.
- Scope freezes project, checkout, machine configuration and collaboration policy. Authorization, scope and remote are checked again before each mutation; the native worker revalidates actual GitHub identity and repository numeric identity against its prepared receipt.
- The package and individual write intent are persisted before dispatch. An unknown or malformed acknowledgement locks that item against editing or blind resubmission. **Проверить исход** performs the existing read-only native receipt reconciliation. Confirming an already running/settled package does not send again.
- Restart never resumes native writes. Started items become unknown; unstarted entries from interrupted preparation/dispatch become cancelled. Completed receipts survive partial failure and removal from the visible drawer. Historical packages cannot cancel or notify for a later draft revision.
- Recipient notices use an idempotent local outbox effect replayed on restart. A shared Project owner gets one coalesced notification per package/project with sender and created Issue URLs only. No GPT/Intake transcript or native conversation ID crosses accounts. **Изучить** opens the recipient's own Intake with exact sources; packages over five Issues are offered in explicit groups of five to retain Intake's bounded evidence contract. Sending the analysis remains explicit.
- Loaded rows and the editor stay mounted during polling. Unchanged reads return only a version token. Visible items are capped at 200 with an approximately 2 MiB collection admission budget; a 5,000-item lifetime receipt ceiling prevents unbounded idempotency storage. Archived receipt IDs are retained rather than reused. Package reads retain active packages and three recent results. Running preparation/dispatch and uncertain writes participate in maintenance blockers.

## Verification and release

Focused fixture tests cover exact selections, public-source restrictions, own-project targeting, edited multi-repository packages, actual publisher display, lost acknowledgements, malformed receipts, per-item revocation, restart, local notice isolation/coalescing, private IDs and maintenance guards. Existing GitHub worker checks verify its fixed typed operations and native receipt recovery. No real GitHub Issues are published during development tests.

Chromium and WebKit acceptance covers block collection, unsaved editor retention, quiet refresh, exact reviewed publication once, integrated Issue/source viewing and conversation draft retention. Geometry and screenshots cover four themes at phone, keyboard-constrained phone, portrait tablet and wide tablet sizes. Project GPT acceptance additionally collects a real canonical fixture answer through the embedded GPT UI. These are browser/native-transport fixtures, not physical device or live model acceptance.

The installed Windows `githubWorkProbe.js` contract is unchanged and is verified through Hub → SSH against this release's compiled hash. Packaging and guarded installation remain distinct from source completion; ordinary upgrades wait for active work.
