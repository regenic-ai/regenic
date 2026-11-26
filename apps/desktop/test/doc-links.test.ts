import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cloudDocLinks, fileTypeLabel, formatFileSize } from "../src/renderer/src/doc-links.ts";

describe("cloud doc cards", () => {
  it("keeps a Feishu title and a Google Docs address without fetching either", () => {
    const links = cloudDocLinks(
      "看下 需求文档 (https://example.feishu.cn/docx/abc) 和 https://docs.google.com/document/d/xyz/edit",
    );
    assert.deepEqual(links, [
      { title: "需求文档", url: "https://example.feishu.cn/docx/abc" },
      { title: "xyz", url: "https://docs.google.com/document/d/xyz/edit" },
    ]);
  });

  it("labels a spreadsheet by its extension and size", () => {
    assert.equal(fileTypeLabel("预算.xlsx", "application/octet-stream"), "XLSX");
    assert.equal(fileTypeLabel("attachment", "image/png"), "PNG");
    assert.equal(formatFileSize(1536), "1.5 KB");
  });
});