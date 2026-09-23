# Inline image continuity

Codex rebuilt Markdown image/link component types whenever chat state changed.
React consequently unmounted loaded images, discarded their resolved URLs and
resolved them again. GPT memoized unchanged text, but changed text still rebuilt
the same component types. Both clients now use stable artifact components with
current callbacks held separately; streamed text keeps existing image elements.

Native images are already gated by IntersectionObserver before resolution. They
now load eagerly after resolution: WebKit could stall the second lazy-loading
gate while the undecoded image had zero dimensions. Remote thumbnails retain
browser lazy loading. Private URLs and exact Results navigation are unchanged.

Verification: the artifact navigation browser test fails its DOM-identity check
with the previous Codex renderer and passes with the fix in Chromium and WebKit.
Five message replacements preserve the loaded image without another reveal
request. Existing phone/tablet/desktop checks cover exact image/file navigation,
draft and attachment continuity. Linux TypeScript and production web build pass.
