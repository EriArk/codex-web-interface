import assert from "node:assert/strict";
import test from "node:test";
import { gptHistory } from "../apps/hub/dist/gpt-history.js";
import { gptLinkedText } from "../apps/hub/dist/gpt-links.js";

const marker = (type, ...parts) => "\ue200" + [type, ...parts].join("\ue202") + "\ue201";
test("native GPT URL cards and grouped sources survive canonical history at their original positions", () => {
  const a = marker("url", "Store", "turn123search0"),
    b = marker("url", "Store", "turn123search1"),
    cite = marker("cite", "turn123search1");
  const body = "- **Game A** — " + a + "\n- **Game B** — " + b + "\nAvailable. " + cite;
  const metadata = {
    content_references: [
      { type: "url", matched_text: a, title: "Store", item: { url: "https://example.com/game-a" } },
      { type: "url", matched_text: b, title: "Store", item: { url: "https://example.com/game-b" } },
      {
        type: "grouped_webpages",
        matched_text: cite,
        items: [
          {
            url: "https://example.com/game-b",
            attribution: "Store",
            supporting_websites: [{ url: "https://news.example.com/story", attribution: "News" }],
          },
        ],
      },
      {
        type: "sources_footnote",
        matched_text: " ",
        sources: [{ url: "https://irrelevant.example" }],
      },
    ],
  };
  const history = {
    current_node: "answer",
    mapping: {
      answer: {
        message: {
          id: "answer",
          author: { role: "assistant" },
          channel: "final",
          content: { content_type: "text", parts: [body] },
          metadata,
        },
      },
    },
  };
  const result = gptHistory(history)[0].text;
  assert.equal(
    result,
    '- **Game A** — [Store](<https://example.com/game-a>)\n- **Game B** — [Store](<https://example.com/game-b>)\nAvailable. [Store](<https://example.com/game-b> "Источник") [News](<https://news.example.com/story> "Источник")',
  );
  assert.doesNotMatch(result, /turn123|irrelevant|\ue200/);
});
test("GPT links preserve ordinary Markdown, safely escape labels and never invent unresolved destinations", () => {
  const ordinary =
    "[Named](https://example.com/a) https://example.com/b\n\n\x60\x60\x60text\nhttps://example.com/code\n\x60\x60\x60";
  assert.equal(gptLinkedText(ordinary, {}), ordinary);
  assert.equal(
    gptLinkedText(marker("url", "Direct", "https://example.com/a_(b)"), {}),
    "[Direct](<https://example.com/a_(b)>)",
  );
  for (const url of [
    "javascript:alert(1)",
    "data:text/html,evil",
    "file:///secret",
    "https://user:password@example.com",
    "https://example.com/\nunsafe",
  ]) {
    const tag = marker("url", "Link", url);
    assert.equal(gptLinkedText(tag, {}), "");
    assert.equal(
      gptLinkedText(tag, {
        content_references: [{ matched_text: tag, type: "url", item: { url } }],
      }),
      "",
    );
  }
  const tag = marker("url", "Link", "turn123search0");
  assert.equal(gptLinkedText(tag + marker("memcite"), {}), "");
  const escaped = gptLinkedText(tag, {
    content_references: [
      {
        matched_text: tag,
        type: "url",
        title: "A [label] <img>\n next",
        item: { url: "https://example.com/a?b=1&c=2" },
        prompt_text: "PRIVATE",
        alt: "[Injected](javascript:alert(1))",
      },
    ],
  });
  assert.equal(escaped, "[A \\[label\\] \\<img\\>  next](<https://example.com/a?b=1&c=2>)");
  assert.doesNotMatch(escaped, /PRIVATE|Injected|javascript/);
});
