import assert from "node:assert/strict";
import test from "node:test";
import {
  helpArticle,
  helpArticles,
  helpCategories,
  searchHelp,
} from "../apps/web/src/helpContent.ts";

test("guide has reachable unique articles, categories and exact related links", () => {
  const ids = helpArticles.map((article) => article.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(new Set(helpCategories).size, helpCategories.length);
  for (const article of helpArticles) {
    assert(helpCategories.includes(article.category));
    assert(article.group && article.title && article.summary);
    assert.equal(
      new Set(article.sections.map((section) => section.title)).size,
      article.sections.length,
    );
    for (const id of article.related) {
      assert(helpArticle(id), `Broken related link: ${article.id} -> ${id}`);
      assert.notEqual(id, article.id);
    }
  }
  for (const category of helpCategories)
    assert(helpArticles.some((article) => article.category === category));
  for (const id of [
    "codex",
    "gpt",
    "files",
    "editor",
    "shared",
    "results",
    "activity",
    "brainstorm",
    "keys",
  ])
    assert(helpArticle(id), `Broken contextual entry: ${id}`);
});
test("search finds body text, normalizes Cyrillic case/yo, and requires all words", () => {
  assert(searchHelp("  УЧЕТН  ").some((article) => article.id === "shared-rights"));
  assert(searchHelp("слияние исходной").some((article) => article.id === "file-merge"));
  assert(searchHelp("неопределённая").some((article) => article.id === "glossary"));
  assert.deepEqual(searchHelp("xy_not_a_topic_123"), []);
  assert.deepEqual(searchHelp("слияние xy_not_a_topic_123"), []);
  assert.equal(searchHelp("   ").length, helpArticles.length);
});
