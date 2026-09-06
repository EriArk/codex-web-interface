# Native catalog, continuity and mobile Remote

## Projects and conversations

The Hub uses the installed App Server's native project/list and project/create APIs. Each machine still needs one configured, enabled seed project so SSH can start its App Server in a known directory. The Companion launches at that seed; project working directories are passed through native Codex RPC. Adding a project does not add a Windows network listener or another Companion process.

Configured roots retain their Hub IDs. Discovered projects have stable machine/native-ID mappings in SQLite. The browser refreshes metadata every minute while visible and when returning to the page; the project drawer also has an explicit refresh action. External thread metadata is matched by native project ID, primary working directory, then secondary roots. Source files and repositories remain on Windows.

The project dialog creates a real folder or connects an existing absolute directory on the selected machine. Its authenticated directory picker lists folders only. Creation uses a native idempotency key and the Hub's existing CSRF/session boundary. A desktop-created project needs no manual Hub config entry.

The installed desktop application also keeps its own saved-folder list. A project created through App Server was verified in the native project catalog, but did not immediately appear in the already-open desktop sidebar. Open its directory in desktop Codex when using it there. Do not edit the desktop application's internal global-state files or restart a running user session to force a refresh. ChatGPT cloud projects are separate from native Codex projects.

## History and continuation

thread/list discovers metadata with useStateDbOnly and excludes subagents. Opening a conversation uses thread/read with includeTurns=false, then item pages. The browser receives at most 20 conversation messages, with a Hub-owned opaque cursor for another 20. Command output is normalized into Results rather than mixed into chat. Unknown source timestamps are left blank.

Paginated threads use thread/items/list. Older legacy threads reject that method, so the adapter reads one native turn at a time using thread/turns/list and keeps only the required chat page plus cursor leftovers. Long legacy turns can take longer to read on Windows, but the browser still receives a bounded page. Saved native turn cursors support Results-to-turn navigation in legacy history.

Native and Hub event snapshots reconcile message IDs before taking the stream cursor. This prevents duplicate assistant text and lost attachment links during an active-turn reload. Visible conversations check native update metadata every 12 seconds; an older reading position gets a new-message button instead of an automatic jump.

The Hub is the owner's primary client and resumes the actual native thread ID. It retains its writer between turns for the lifetime of the machine runtime; there is no per-turn unsubscribe/resume race. After idle teardown or restart, it resumes that same native ID again. It never automatically resends an unacknowledged prompt. Native drafts are not persisted until their first turn: the Hub renders an unsent draft locally and can recreate only that empty draft after App Server loss. Existing conversation IDs are retained.

Continuation of the same native ID works after its writer is released. Codex 0.153.4 on Windows can retain a paginated thread's writer in the desktop App Server even when its visible turn has finished. A second App Server then rejects thread/resume with "already has an active writer". The installed Windows daemon/proxy route is not available (daemon commands are Unix-only); there is no supported writer-takeover flag. Do not stop the owner's desktop or edit its private state to bypass this lock.

For the owner's web-only workflow, finish any active desktop task and fully quit desktop ChatGPT/Codex once (including the tray process), leaving the independently scheduled CodexWeb Companion running. Closing a browser tab is not this migration step. The next web send resumes the original native conversation; no copied history or replacement ID is needed.

The Hub returns HTTP 409 THREAD_IN_USE if another client still owns the writer. It preserves the draft and attachments and offers "Проверить доступ", which only resumes the same native ID. It never sends the draft automatically. The UI no longer suggests creating a copy to resolve an ordinary send failure.

The explicit native fork API remains available for deliberate branching. Native thread/fork copies context through the latest completed/interrupted/failed turn into a new native ID; an in-progress turn is excluded. Pending files receive new private Hub IDs; originals stay intact. The copied draft is shown for review and is sent only when the user presses Send. No automatic fork or resend occurs. This is an available fallback, not transparent synchronization of two writers. Native desktop activity and questions are not Hub-owned streamed turns; questions started through this Hub use the native request/response channel.

## Remote input and layout

Phone-sized viewports default to a relative trackpad, tablet-sized viewports to direct touch. Preferences are remembered per viewport class without user-agent sniffing. A stylus always uses direct coordinates; palm touches are ignored while a pen contact is active.

One Pointer Events controller handles input:
- one-finger trackpad movement and tap to click;
- double tap and hold, or long hold, to drag;
- two-finger scrolling and two-finger tap for right click;
- pinch zoom, direct-touch panning, mouse and pen input;
- cancellation and key/button release on blur, suspend and teardown.

Input mode changes do not reconnect the Guacamole session. Mouse movement is batched per animation frame; button transitions are delivered immediately. A small trackpad position marker replaces the oversized software cursor.

On compact screens a connected Remote view occupies the entire available viewport, including phone landscape. Back, keyboard, expansion and settings float over the image. Gesture help, modifiers, zoom and screenshot actions are in an optional control panel. On iPad the pane can expand from the wide workspace. Returning to Chat preserves chat state.

## Themes

All three references in references/ were inspected, and the same functional markup uses semantic tokens and CSS materials:
- organizer: warm paper, binding hardware, sage selections, layered edges and pastel bookmarks;
- crt-green: rounded dark CRT housing, phosphor-green borders and sharp monospace text;
- hitech-2000s: light silver housing, screws, beveled panels and cyan button illumination.

Phone decoration is reduced to narrow edges. Connected immersive Remote removes every theme bezel. Screenshots and artifacts retain their actual colors.

Organizer and hi-tech share self-hosted Roboto Condensed (Latin/Cyrillic, weights 400–700, SIL OFL 1.1); CRT retains its sharp monospace face. Compact mobile spacing and a smaller visible composer value row preserve 44px native picker touch areas. Editable inputs/native picker text remain 16px. Font assets are served and cached by the Hub; clients make no font-provider requests.

Projects expand their own thread lists in place and multiple folders may remain expanded. The separate "Диалоги" tab contains unassigned conversations, represented by one virtual Hub bucket per configured machine, retaining the original working directory. A bucket is not a new native project. Results put loaded images first and collapse commands/code until explicitly expanded.

## Verification

Build and browser workloads run on Linux. See VERIFICATION.md for native tests, browser fixtures and remaining physical iOS checks. Private screenshots and QA credentials stay in ignored .local directories.

## Switching between website and native desktop

Settings → «Работать с компьютера» releases the machine's web writers. If web tasks are active, «Остановить и передать» interrupts them and waits for native acknowledgement. In desktop Codex press Retry in the same chat. Retry reloads saved context; send «продолжай» if the interrupted task should continue. Pending queue entries remain native, and no task is resent automatically.

Settings → «Продолжить на сайте» returns the machine. If desktop Codex is still running, «Закрыть и вернуть» closes it and stops its current tasks. The independent Companion stays running. Wait for the completion notice, then send in the same website chat. If the desktop is already fully closed, no close confirmation is needed. Opening the website for reading does not take a desktop writer; external messages are synchronized through bounded read-only history refreshes.

Ordinary chats in the official mobile ChatGPT app are independent and can be used alongside the website. Connecting to this computer through official «Удалённо» participates in native Codex ownership and can compete for the same conversation.
