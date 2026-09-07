type Json = Record<string, unknown>;
const record = (value: unknown): Json =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
const text = (value: unknown) => (typeof value === "string" ? value : "");
const rows = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

function publicUrl(value: unknown): string | undefined {
  const raw = text(value);
  if (
    !/^https?:\/\//i.test(raw) ||
    raw.length > 8192 ||
    [...raw].some((c) => c.charCodeAt(0) <= 32 || c.charCodeAt(0) === 127)
  )
    return;
  try {
    const url = new URL(raw);
    if (url.username || url.password) return;
    return url.href;
  } catch {
    return;
  }
}
function link(value: unknown, label: unknown, source: boolean): string {
  const url = publicUrl(value);
  if (!url) return "";
  // Encode Markdown syntax, keeping labels literal and destinations out of HTML.
  const title = (text(label).trim() || new URL(url).hostname)
    .slice(0, 400)
    .replace(/./gs, (c) => (c.charCodeAt(0) < 32 ? " " : c))
    .replace(/[\ue200-\ue203]/g, " ")
    .replace(/[\\\x60*_[\]<>!]/g, "\\$&");
  const destination = url.replace(
    /[<>"\\]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
  return "[" + title + "](<" + destination + ">" + (source ? ' "Источник"' : "") + ")";
}

/** Resolve public native reference markers before discarding unsupported UI tokens. */
export function gptLinkedText(body: string, metadata: unknown): string {
  const references = new Map<string, Json>();
  for (const value of rows(record(metadata).content_references).slice(0, 2000)) {
    const ref = record(value),
      match = text(ref.matched_text);
    if (/^\ue200[^\ue201]*\ue201$/.test(match)) references.set(match, ref);
  }
  return body.replace(/\ue200([^\ue201]*)\ue201/g, (match, inner: string) => {
    const ref = references.get(match);
    if (ref?.type === "url") {
      const item = record(ref.item);
      return link(item.url, ref.title || item.title, false);
    }
    if (ref?.type === "grouped_webpages" || ref?.type === "webpage") {
      const items =
        ref.type === "webpage"
          ? [ref.item ?? ref]
          : [...rows(ref.items), ...rows(ref.fallback_items)];
      const seen = new Set<string>();
      const links: string[] = [];
      for (const value of items
        .flatMap((v) => [v, ...rows(record(v).supporting_websites)])
        .slice(0, 64)) {
        const item = record(value),
          url = publicUrl(item.url);
        if (!url || seen.has(url)) continue;
        seen.add(url);
        links.push(link(url, item.attribution || item.title, true));
      }
      return links.join(" ");
    }
    // During streaming, a direct URL can precede its metadata. Never guess search IDs.
    const parts = inner.split("\ue202");
    if (!ref && parts[0] === "url" && parts.length === 3) return link(parts[2], parts[1], false);
    return "";
  });
}
