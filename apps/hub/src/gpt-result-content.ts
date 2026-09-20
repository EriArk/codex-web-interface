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
};
const label = (node: Node): string => node.value ?? (node.children ?? []).map(label).join("");

/** Parse visible Markdown, not URLs inside code, HTML source or image data. */
export function gptResultContent(text: string, publicBaseUrl?: string) {
  const tree: Node = parser.parse(text);
  const definitions = new Map<string, string>();
  const links = new Map<string, string>();
  const demos: string[] = [];
  const origin = publicBaseUrl ? new URL(publicBaseUrl).origin : undefined;
  function collect(node: Node) {
    if (node.type === "definition" && node.identifier && node.url)
      definitions.set(node.identifier, node.url);
    for (const child of node.children ?? []) collect(child);
  }
  collect(tree);
  function visit(node: Node) {
    if (node.type === "code") {
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
  return { links, demos };
}
