# Inline file previews and compact pinned navigation

Issue #61 uses the existing authenticated DownloadLink save/share flow in both clients.
The original File is retained, and only a fresh tap starts native sharing. Preview errors
do not disable saving. Closing leaves chat state, draft and scroll intact.

- Raster images render inline; image decoding failure falls back to a type/size card.
- PDF.js 6.3.289 is a lazy chunk with a same-origin bundled worker. Render one page at a time
  into a bounded canvas, no annotations/actions, XFA or native viewer navigation. Limit input
  to 12 MiB and each loading/rendering operation to 15 seconds. Encrypted/malformed PDFs
  keep the original save action available.
- Text/Markdown/JSON/code show up to 64 KiB literally, preserving whitespace. Larger text
  explicitly indicates that only the beginning is shown. Binary data is not interpreted.
- HTML/SVG up to 256 KiB use the existing opaque-origin sandbox and preview CSP. The new
  frame endpoint stores at most 16 short-lived renderings (10 minutes), bound to the creating
  login session. It accepts already downloaded bytes and never reads a supplied path/URL.
  Unmount deletes the frame, including a late preparation response. CSRF protects mutations;
  iframe-only fetch context, session ownership, no-store and the unchanged restrictive CSP
  protect reads. Network, parent DOM, forms and popups remain blocked.
- Office, archive, CAD and other unsupported files use a type/size card; no fragile conversion.

Helmet's optional explicit Origin-Agent-Cluster opt-in is omitted: Chromium's isolated-frame
painting/input failed with this header in the browser regression fixture, including a minimal
independent reproduction. Browser-default agent clustering remains. This is not the preview
security boundary: opaque sandbox origins, CSP, authentication, COOP and CORP remain intact.
The HTML standard also defines opaque-origin documents as unconditionally origin-keyed:
https://html.spec.whatwg.org/multipage/browsers.html#origin-keyed-agent-clusters

Pinned navigation is shared by Codex/GPT projects and conversations. The default panel shows
three pins sorted by active work, then latest activity. The arrow expands/collapses the rest;
the choice persists locally and synchronizes both mounted navigation shells. Search reveals
all matching pins. Unpinned live work remains ahead of inactive pins. Row menus and status
indicators are unchanged. All four themes use existing semantic tokens.

Verification: isolated Fastify authentication/session/CSRF/size/capacity tests; Chromium and
WebKit file previews in phone portrait, phone landscape and tablet-wide viewports; exact
original share bytes and fresh activation, preview failure fallback, draft/scroll preservation;
pinned navigation recency, persistence, search, live priority and action-menu checks in both
clients. Existing download and 25-vector preview isolation regressions remain required.
Physical iPhone/iPad acceptance remains the owner's everyday testing, not a claimed lab pass.
