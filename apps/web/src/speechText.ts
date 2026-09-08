import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

type TextNode = { type: string; value?: string; children?: TextNode[] };
const parser = unified().use(remarkParse).use(remarkGfm);
// Only the public message body enters this function, never activity or reasoning payloads.
export function speechText(markdown: string): string {
  const visit = (node: TextNode): string => {
    if (
      ["code", "html", "image", "imageReference", "definition", "footnoteDefinition"].includes(
        node.type,
      )
    )
      return "";
    if (node.type === "text" || node.type === "inlineCode") return node.value ?? "";
    if (node.type === "break") return "\n";
    const content = (node.children ?? []).map(visit).join(node.type === "tableRow" ? ", " : "");
    return ["paragraph", "heading", "listItem", "blockquote", "tableRow"].includes(node.type)
      ? content + "\n\n"
      : content;
  };
  return visit(parser.parse(markdown))
    .replace(/(?:https?:\/\/|sandbox:)[^\s<>]+/giu, "")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
export function speechChunks(text: string, maximum = 360): string[] {
  const chunks: string[] = [];
  let current = "";
  const flush = () => {
    if (current) chunks.push(current);
    current = "";
  };
  // Split oversized sentences by words, and oversized tokens by Unicode code points.
  for (const paragraph of text.split(/\n+/)) {
    for (const sentence of paragraph.match(/[^.!?。！？]+[.!?。！？]*[”’»]?/gu) ?? []) {
      const clean = sentence.trim();
      if (!clean) continue;
      if (clean.length <= maximum) {
        if (current && current.length + clean.length + 1 > maximum) flush();
        current += (current ? " " : "") + clean;
      } else {
        for (const word of clean.split(/\s+/u)) {
          if (current && current.length + word.length + 1 > maximum) flush();
          let fragment = "";
          for (const point of word) {
            if (fragment.length + point.length > maximum) {
              flush();
              chunks.push(fragment);
              fragment = "";
            }
            fragment += point;
          }
          if (fragment) current += (current ? " " : "") + fragment;
        }
      }
    }
    flush();
  }
  return chunks;
}
