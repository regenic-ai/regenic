import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cloudDocKind, cloudDocLinks, fileTypeLabel, formatFileSize, textWithoutCloudDocs } from "../src/renderer/src/doc-links.ts";

describe("cloud doc cards", () => {
  it("keeps a Feishu title and a Google Docs address without fetching either", () => {
    const links = cloudDocLinks(
      "看下 需求文档 (https://example.feishu.cn/docx/abc) 和 https://docs.google.com/document/d/xyz/edit",
    );
    assert.deepEqual(links, [
      { title: "需求文档", url: "https://example.feishu.cn/docx/abc", kind: "DOC", host: "feishu" },
      { title: "", url: "https://docs.google.com/document/d/xyz/edit", kind: "DOC", host: "google" },
    ]);
    assert.equal(
      textWithoutCloudDocs("看下 需求文档 (https://example.feishu.cn/docx/abc) 其余"),
      "看下 其余",
    );
    assert.equal(cloudDocKind("https://example.feishu.cn/sheets/abc"), "XLS");
    assert.equal(cloudDocKind("https://docs.google.com/presentation/d/abc/edit"), "PPT");
    assert.equal(cloudDocKind("https://example.feishu.cn/wiki/abc"), "WIKI");
    assert.equal(cloudDocKind("https://example.feishu.cn/wiki/abc?sheet=ik"), "XLS");
    assert.equal(cloudDocKind("https://example.feishu.cn/base/abc"), "BASE");
    assert.equal(cloudDocKind("https://example.feishu.cn/file/abc"), "FILE");
    assert.equal(cloudDocKind("https://drive.google.com/file/d/abc/view"), "FILE");
  });

  it("uses a written title and drops the address, the id, and the html", () => {
    const markdown = "请审核：[ Bioby & Figurelabs - 飞书云文档](https://mxhvxf1j6o.feishu.cn/wiki/ZiY5woaMNisxB9k679ncXUZjnoc?sheet=ikVQ1K)";
    const [card] = cloudDocLinks(markdown);
    assert.equal(card.title, "Bioby & Figurelabs - 飞书云文档");
    assert.equal(card.kind, "XLS");
    assert.equal(textWithoutCloudDocs(markdown), "请审核：");

    const bare = "达人已更新脚本同步在文档https://ecncw7du1qtr.feishu.cn/docx/J2OrdbIhVoRs7Sx7RlEcM5winNf?from=from_copylink";
    assert.equal(cloudDocLinks(bare)[0]?.title, "");
    assert.equal(cloudDocLinks(bare)[0]?.kind, "DOC");
    assert.equal(textWithoutCloudDocs(bare), bare);

    const html = "<p>@youssef please check: https://docs.google.com/document/d/1Wgojia1WXZxo2fktqTjcVCpBLh5k-3hTJfO-n87GLOQ/edit?usp=sharing</p>";
    const google = cloudDocLinks(html)[0];
    assert.equal(google?.title, "");
    assert.equal(google?.host, "google");
    assert.equal(google?.url.endsWith("</p>"), false);
    const plainGoogle = textWithoutCloudDocs(html);
    assert.equal(plainGoogle.includes("</p>"), false);
    assert.equal(plainGoogle.includes(google?.url ?? "missing"), true);

    const drive = "please check: https://drive.google.com/file/d/1iswqP41CPsRVoIcHGTk4du6Whb3BjLi_/view?usp=drivesdk";
    assert.equal(cloudDocLinks(drive)[0]?.kind, "FILE");
    assert.equal(textWithoutCloudDocs(drive), drive);

    const labeled = "麻烦审核： short: https://docs.google.com/document/d/shortId/edit long: https://docs.google.com/document/d/longId/edit";
    assert.deepEqual(cloudDocLinks(labeled).map((link) => link.title), ["", ""]);
    assert.equal(textWithoutCloudDocs(labeled), labeled);
  });

  it("labels a spreadsheet by its extension and size", () => {
    assert.equal(fileTypeLabel("预算.xlsx", "application/octet-stream"), "XLSX");
    assert.equal(fileTypeLabel("attachment", "image/png"), "PNG");
    assert.equal(formatFileSize(1536), "1.5 KB");
  });
});