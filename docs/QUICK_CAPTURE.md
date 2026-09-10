# Quick Capture

The shared sidebar search row opens a compact Note/Task capture dialog in either client. The current real project is the initial destination; otherwise the last destination or Unassigned is used. An unfinished device draft keeps its existing destination when the owner changes clients. Optional Task priority/date controls are collapsed. Saving offers a direct link into the ordinary Notes/Tasks editor and does not navigate the chat.

Text is bounded at 64 KiB and preserved exactly in the existing Note/Task body. Its first nonempty line supplies the editable title. There is no separate inbox content store, background clipboard access, URL fetching, native writer or model call. OS share-target integration is not claimed.

Schema 23 adds only compact capture receipts. The typed authenticated/CSRF-protected save checks one identity across both destinations, writes the normal item and receipt in one transaction, and rejects reuse with changed contents. A lost acknowledgement retries the frozen input and identity. A deleted item is reported as missing rather than recreated. Existing item revisions, filters, project associations and limits remain in use.

The single device draft is bounded and retained after accidental close. Pending saves freeze their payload until explicitly checked; definitive validation/capacity rejections permit editing. Logout clears capture state. A late response cannot reopen a dismissed dialog or repopulate private device preferences after logout. Browser tests verify Codex/GPT drafts and destination selection, four-theme phone/tablet layouts, reduced keyboard viewport and lost-save recovery. Physical iOS share/keyboard behavior remains owner verification.
