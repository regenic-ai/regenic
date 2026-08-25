import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  importWhatsAppFiles,
  whatsAppImportSummary,
} from "../src/renderer/src/whatsapp-import.ts";

describe("WhatsApp multi-file import", () => {
  it("imports sequentially, isolates a failed file, and totals successful files", async () => {
    let active = 0;
    let maxActive = 0;
    const files = ["one.csv", "bad.csv", "two.jsonl"].map((name) => ({
      name,
      async text() {
        return name;
      },
    }));

    const result = await importWhatsAppFiles(files, async (content, fileName) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active -= 1;
      if (fileName === "bad.csv") {
        throw new Error("invalid header");
      }
      assert.equal(content, fileName);
      return {
        file_hash: fileName,
        accepted_count: fileName.endsWith(".csv") ? 2 : 3,
        duplicate_count: 1,
        invalid_line_count: 0,
        errors: [],
      };
    });

    assert.equal(maxActive, 1);
    assert.deepEqual(result, {
      total_files: 3,
      completed_files: 2,
      accepted_count: 5,
      duplicate_count: 2,
      invalid_line_count: 0,
      failures: [{ file_name: "bad.csv", message: "invalid header" }],
    });
    assert.equal(
      whatsAppImportSummary(result),
      "Processed 2 of 3 files · 5 new · 2 duplicates · 0 invalid lines.",
    );
  });
});