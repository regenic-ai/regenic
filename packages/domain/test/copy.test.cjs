const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  DEFAULT_COPY_LOCALE,
  defineLocaleTables,
  parseCopyLocale,
  resolveCopy,
  resolveLocaleHref,
} = require("../dist");

const tables = defineLocaleTables({
  en: {
    "catalog.title": "Feishu",
    "present.pickedCount": "{count} conversations",
  },
  zh: {
    "catalog.title": "飞书",
    "present.pickedCount": "{count} 个会话",
  },
});

describe("plugin copy", () => {
  it("parses query and Accept-Language tags", () => {
    assert.equal(parseCopyLocale("zh"), "zh");
    assert.equal(parseCopyLocale("zh-CN"), "zh");
    assert.equal(parseCopyLocale("zh-CN,zh;q=0.9,en;q=0.8"), "zh");
    assert.equal(parseCopyLocale("en-US"), "en");
    assert.equal(parseCopyLocale("fr"), "en");
    assert.equal(parseCopyLocale(undefined), DEFAULT_COPY_LOCALE);
  });

  it("resolves keys, params, literals, and missing extras", () => {
    assert.equal(resolveCopy(tables, "zh", "catalog.title"), "飞书");
    assert.equal(
      resolveCopy(tables, "zh", { key: "present.pickedCount", params: { count: 3 } }),
      "3 个会话",
    );
    assert.equal(resolveCopy(tables, "en", { literal: "engineering" }), "engineering");
    assert.equal(resolveCopy(tables, "zh", "unknown.key"), "unknown.key");
    assert.equal(resolveCopy(tables, "zh", "Extra review"), "Extra review");
    assert.equal(resolveCopy(tables, "zh", undefined), undefined);
  });

  it("picks href from a locale map", () => {
    assert.equal(
      resolveLocaleHref(
        { en: "https://example.com/en", zh: "https://example.com/zh" },
        "zh",
      ),
      "https://example.com/zh",
    );
    assert.equal(resolveLocaleHref("https://example.com/docs", "zh"), "https://example.com/docs");
  });
});
