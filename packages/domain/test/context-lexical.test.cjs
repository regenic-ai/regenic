const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { contextLexicalQueryTerms, contextLexicalTerms, scoreContextLexicalText } = require("../dist");

describe("Context lexical terms", () => {
  it("keeps Latin words whole and segments CJK into words", () => {
    const terms = contextLexicalQueryTerms("看下最近有哪些Excel文件");
    assert.ok(terms.includes("excel"));
    assert.ok(terms.includes("文件") && terms.includes("最近"));
    for (const fragment of ["e", "c", "ce", "xce", "l文", "el文", "最近有"]) assert.ok(!terms.includes(fragment), fragment);
    assert.deepEqual(contextLexicalTerms("C语言v2版本"), ["c", "语言", "v2", "版本"]);
  });

  it("does not treat a character inside another word as a query term", () => {
    assert.equal(scoreContextLexicalText("目前就发了2个队吧", "团队最新进展").lexical, 0);
    assert.ok(scoreContextLexicalText("团队本周进展", "团队最新进展").lexical > 0);
  });

  it("does not score Latin substrings of unrelated words as matches", () => {
    assert.equal(scoreContextLexicalText("width=device-width family=Space", "Excel文件").lexical, 0);
    assert.ok(scoreContextLexicalText("Q3 Excel workbook", "看下Excel文件").lexical > 0);
    assert.ok(scoreContextLexicalText("季度文件汇总", "看下Excel文件").lexical > 0);
  });
});
