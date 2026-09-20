import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

const parser = unified().use(remarkParse).use(remarkGfm);
type Node = {
  type: string;
  url?: string;
  identifier?: string;
  value?: string;
  lang?: string | null;
  children?: Node[];
  position?: { start: { offset?: number; column: number }; end: { offset?: number } };
};
const label = (node: Node): string => node.value ?? (node.children ?? []).map(label).join("");

/** Parse visible Markdown, not URLs inside code, HTML source or image data. */
export function gptResultContent(text: string, publicBaseUrl?: string) {
  const tree: Node = parser.parse(text);
  const definitions = new Map<string, string>();
  const links = new Map<string, string>();
  const demos: string[] = [];
  const blocks: { index: number; text: string; language: string }[] = [];
  let blockIndex = 0;
  const origin = publicBaseUrl ? new URL(publicBaseUrl).origin : undefined;
  function collect(node: Node) {
    if (node.type === "definition" && node.identifier && node.url)
      definitions.set(node.identifier, node.url);
    for (const child of node.children ?? []) collect(child);
  }
  collect(tree);
  function visit(node: Node) {
    if (node.type === "code") {
      const index = blockIndex++;
      // Top-level fenced blocks have an exact source slice. Preserve its UTF-8 text,
      // CRLF and trailing newline instead of serializing the Markdown AST.
      const raw = text.slice(node.position?.start.offset, node.position?.end.offset);
      const opening = /^( {0,3})(`{3,}|~{3,})[^\r\n]*\r?\n/.exec(raw);
      if (opening && node.position?.start.column === 1) {
        const fence = opening[2]!;
        const closing = new RegExp(
          "(?:^|\\n) {0,3}" + fence[0] + "{" + fence.length + ",}[ \\t]*\\r?$",
        ).exec(raw);
        if (closing) {
          const end = closing.index + (raw[closing.index] === "\n" ? 1 : 0);
          blocks.push({
            index,
            text: raw.slice(opening[0].length, end),
            language: (node.lang ?? "").slice(0, 80),
          });
        }
      }
      if (
        node.lang?.toLowerCase() === "html" &&
        /<(?:html|div|main|section|body|canvas|svg)\b/i.test(node.value ?? "") &&
        demos.length < 8
      )
        demos.push(node.value!);
      return;
    }
    const raw =
      node.type === "link"
        ? node.url
        : node.type === "linkReference"
          ? definitions.get(node.identifier ?? "")
          : undefined;
    if (raw && /^https?:\/\//i.test(raw) && raw.length <= 8192 && !/[\x00-\x20\x7f]/.test(raw)) {
      try {
        const url = new URL(raw);
        if (!url.username && !url.password && url.origin !== origin)
          links.set(url.href, label(node).trim().slice(0, 400) || url.hostname);
      } catch {
        /* Invalid destinations are not actionable links. */
      }
    }
    for (const child of node.children ?? []) visit(child);
  }
  visit(tree);
  return { links, demos, blocks };
}
