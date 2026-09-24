# File workspace and technical viewers

The explicit Preview/Open action opens one large themed file workspace above the mounted parent. The header keeps filename, properties, expand and Close; format tools stay above the viewport; original Download remains available independently. Properties use a side column on wide screens and a bounded lower section on phones. The same shell is intended for future conversion tools; this release does not implement conversion/export actions for users.

Entry points: Files, Git (working copy or exact index blob), Results, authorized Codex/GPT download links and explicitly shared project files. The viewer never starts a model turn or changes the original. Existing source URLs and download boundaries remain authoritative. Results retain cheap image thumbnails; selecting a card does not load the full viewer. Files side previews do not automatically parse CAD, PDF, HTML or media.

## Capabilities and bounds

`filePreviewRegistry.ts` separates full-viewer capability, cheap thumbnails, parser limits, mobile availability, isolation and server conversion.

| Format | Viewer | Preview boundary |
| --- | --- | --- |
| PNG/JPEG/WebP/GIF/AVIF | Fit, zoom, pan/pinch, background | 32 MiB; native image decoder |
| PDF | Existing worker/page renderer | 12 MiB; bounded canvas/page and timeout |
| TXT, code, JSON/YAML/TOML/XML, CSV/TSV, logs | Exact text with wrap and Copy | First 64 KiB; CSV/TSV stay text |
| Markdown | Reflowing document or original text | Rich rendering up to 32 KiB, otherwise bounded plain text; no raw HTML or external image loads |
| HTML | Existing private sandbox frame | 256 KiB; never inserted into host DOM |
| SVG | Static sanitized SVG image, fit/zoom/pan, physical size/viewBox | 1 MiB, 5,000 nodes; active content, external references, CSS and unsupported elements removed with disclosure |
| STEP/STP, IGES/IGS | Server OpenCascade mesh, shaded 3D | 32 MiB input; fixed mm tessellation; 250,000 triangles / 750,000 vertices / 512 mesh parts |
| STL, OBJ | Worker parser, shared 3D view | Same mesh limits; source units unknown and explicitly interpreted |
| 3MF | Bounded ZIP/XML worker, assemblies and transforms | 128 ZIP entries, 32 MiB expanded, single embedded model, no external components; units from document |
| GLB/glTF | Worker, embedded geometry | glTF 2 triangles, no required extensions/sparse accessors, textures or external buffers; metres per glTF |
| MP3/WAV/OGG/M4A, MP4/WebM | Native controls, no autoplay | Explicit open, 32 MiB; playback depends on browser codecs |
| DXF | dxf-viewer worker with bundled font, layers/mono, rulers and draggable ΔX/ΔY guides | 2 MiB / 20,000 entity markers, 20 seconds, 32 MiB prepared scene; unknown units remain unknown |
| ZIP | Folder navigation, search, nested universal viewer, member download/editable text copy | 32 MiB input/member, 5,000 entries, CRC and local/central identity checks; stored/deflate only |
| DOCX | Reflowing text, headings, bold/italic runs, tables, embedded PNG/JPEG | Worker; content view rather than Word page-layout reproduction |
| XLSX | Named sheets, sparse row/column coordinates, search, cached values and inspectable formulas | Worker; no formula execution or remote resources |
| Other archives, legacy Office, PowerPoint, executables, unknown binary | Download | No misleading generic preview |

3D uses orbit/pan/zoom, named axial views, fit/reset and wireframe. Bounds are measured before presentation normalization. DXF supports the upstream renderer's arcs, polylines, splines, blocks, text and supported other entities; warnings identify incomplete renderings. Snap guides target bounded entity vertices/centres; they are inspection guides, not CAD metrology or edits. Screen rasterization and shading are approximate; originals retain exact bytes.

## Conversion isolation and cache

STEP/IGES run in a disposable Node/OpenCascade process, never in the engine event loop or on the phone. Fixed format and tessellation settings; no caller command/options. At most two conversions per engine process, 256 MiB V8 heap, 512 MiB RSS watchdog on Linux, 25-second conversion deadline, 24 MiB output cap. HTTP work is bounded to 60 seconds and cancelled on disconnect; worker teardown kills the child. No incomplete derivative is persisted, so restarts cannot publish partial output.

The only server input capability is a validated relative existing authenticated file route plus the original SHA-256. It cannot fetch arbitrary URLs or host paths. Reads traverse the existing auth/workspace/source checks, including on cache hits; converted misses are rechecked after conversion. Team conversion has a separate Team endpoint restricted to shared asset routes and rechecks live publication/membership. The response is `private, no-store`.

Derivative cache keys include session, exact source, original content hash, format, converter version and tessellation settings. Cache: 8 entries / 64 MiB / 10-minute TTL, periodic expiry; no bearer derivative URLs or shared public cache. Original authorization is never inferred from a hash or a derivative. Browser mesh workers are terminated on timeout or close and cannot load external companion resources.

## Windows and verification

Git index reads use the self-contained `inspectorProbe` transported by Hub → system SSH → configured Windows Node for each call. The file must be an exact stage-0 regular blob within the authorized project, with a bounded size; symlinks, conflicted entries and hidden paths are rejected. The immutable Git blob ID is read instead of the working file. This probe is delivered with each request, so no installed Scheduled Task or `githubWorkProbe.js` replacement is needed for this change.

Focused evidence: real STEP/IGES converter fixtures; source/CSRF/hash/cache/deletion checks; two-user shared publication and warm-cache revocation; staged versus working bytes; actual live Hub → SSH → Windows index blob verified against Git object hash. Chromium/WebKit cover models, ASCII/binary STL, embedded glTF/GLB, 3MF, DXF layers/guides, hostile SVG, external-buffer rejection and original download/draft continuity. Existing image/PDF/HTML/text and Results explicit-preview regressions remain covered. Screenshots were inspected across four themes, phone, keyboard-constrained phone, compact tablet and wide tablet.

Private acceptance also used the owner's `t5_reader_case_v60_front.step` (8,304,446 bytes): 10,340 triangles, bounds approximately 96.84 × 137 × 18 mm. Owner model bytes are not committed. Browser emulation is not physical iPhone/iPad acceptance; real-device performance and the owner's broader DXF corpus remain to be checked in everyday use. Do not close #167 as physical acceptance on fixture evidence alone.

Libraries: unmodified Three.js (MIT), dxf-viewer (MPL-2.0), occt-import-js (LGPL-2.1/OpenCascade upstream), fast-xml-parser and fflate (MIT), DejaVu font license in `public/fonts`. DXF measurement behaviour is adapted from the owner's MIT [DXF Viewer](https://github.com/EriArk/-DXF-Viewer); attribution retained under `docs/licenses`.


### Direct Results entry — 24 September 2026

File titles and image thumbnails now open this universal viewer directly. The
intermediate Result inspector and duplicate Preview button/tab are removed.
Closing preserves the mounted Results list, category, scroll and original chat
draft. Share/download remain on the original card. Exact chat references open the
same viewer without switching to a later artifact version; unsupported binaries
retain direct download without preloading their body. Chromium and WebKit verify
text/image opening, download bytes, unavailable source recovery, and chat draft /
attachment continuity at phone/tablet/desktop widths.


### ZIP, Word and Excel content viewers — 24 September 2026

Owner scope correction: PowerPoint is not wanted. Do not add presentation viewers
as part of this stage. ZIP, DOCX and XLSX use the same lazy universal workspace
from Files, Results and authorized attachment links. A ZIP member opens above its
mounted archive; returning preserves folder, search and scroll. Text members use
the existing copy editor, with an explicit save destination, never an inferred
writable path from the archive name. Downloads retain original member bytes.

Each parse/extraction runs in a disposable browser worker with a 15-second deadline;
close/source replacement terminates it. Archive indexing never inflates all members.
Selected deflate entries expand in 1 KiB compressed chunks with actual output-size
and CRC checks. Duplicate names and mismatched local/central records are rejected;
unsafe names, symlinks, encryption and unsupported compression are listed but not
opened. ZIP64, multipart archives, RAR/7z and legacy Office remain download-only.
These are preview/parser budgets, not upload/download or manual-editor ceilings.

Office reads only requested internal ZIP parts, up to 64 MiB expanded in total,
8 MiB per XML/image part, 150,000 XML tags and depth 80. DTD/entity declarations and
invalid XML are rejected. React renders structured text, never document HTML.
External relationships, macros, embedded programs and remote resources are never
executed/fetched. Media are bounded embedded PNG/JPEG blobs revoked on close.

Word content reflows in the active theme; numbering, page breaks, complex layouts,
styles and drawings are not reproduced. Large Word tables show up to 100 rows and
50 columns with an explicit partial-content notice. Excel preserves sheet order,
sparse coordinates, inline/shared strings and saved formula values; formulas are
inspectable but never calculated. Numeric values remain as stored (including date
serials); number formats, charts and cell styling are not reproduced. Rendering
uses 100-item pages; the parse budget is 100 sheets, 50,000 cells, 5,000 rows/sheet
and 256 columns, with partial-content disclosure. This is viewing, not an Office
editor or converter. User-requested conversion remains deferred.

Focused tests: ZIP exact bytes/Unicode/CRC/local identity/expansion/encryption/
traversal/duplicate/count limits; DOCX formatting/tables/media; XLSX relationship
order/sparse coordinates/cached formulas; XML entities/corruption/depth rejection.
Chromium and WebKit check nested viewing, text copy-editor availability, download,
folder and draft preservation, search, sheet/page selection and malformed files.
Phone, keyboard-constrained phone, compact/wide tablet screenshots cover all four
themes. Physical-device acceptance remains pending. No Hub/Windows helper contract
changes are required: bytes arrive through existing authenticated file routes.

Implementation uses the existing [fflate streaming API](https://github.com/101arrowz/fflate)
and [fast-xml-parser](https://github.com/NaturalIntelligence/fast-xml-parser), without
new dependencies or public conversion services.
