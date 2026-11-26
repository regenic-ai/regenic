import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { filenameFromContentDisposition, openDownloadName } from "../src/main/download-name.ts";

describe("download names", () => {
  it("keeps a suffixed name from the response", () => {
    const name = openDownloadName(
      "attachment; filename=\"attachment\"; filename*=UTF-8''%E9%A2%84%E7%AE%97.xlsx",
      "attachment",
      Buffer.from("not a spreadsheet"),
    );
    assert.equal(name, "预算.xlsx");
    assert.equal(
      filenameFromContentDisposition("attachment; filename=\"notes.pdf\""),
      "notes.pdf",
    );
  });

  it("adds a suffix from the bytes when the stored name has none", () => {
    const pdf = Buffer.from("%PDF-1.4");
    assert.equal(openDownloadName(null, "attachment", pdf), "attachment.pdf");
    const docx = Buffer.concat([Buffer.from("PK\u0003\u0004"), Buffer.from("word/document.xml")]);
    assert.equal(openDownloadName(null, "attachment", docx), "attachment.docx");
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    assert.equal(openDownloadName(null, "image.png", jpeg), "image.jpg");
    const mp4 = Buffer.alloc(16);
    mp4.write("ftyp", 4);
    mp4.write("isom", 8);
    assert.equal(openDownloadName(null, "attachment", mp4), "attachment.mp4");
    assert.equal(openDownloadName(null, "image.png", mp4), "image.mp4");
  });
});
