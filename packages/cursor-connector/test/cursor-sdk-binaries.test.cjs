const assert = require("node:assert/strict");
const { basename } = require("node:path");
const { describe, it } = require("node:test");
const {
  ensureCursorSdkPlatformBinaries,
  resolveCursorRipgrepPath,
} = require("../dist/cursor-sdk-binaries");

describe("ensureCursorSdkPlatformBinaries", () => {
  it("points CURSOR_RIPGREP_PATH at the SDK platform rg binary", () => {
    const previous = process.env.CURSOR_RIPGREP_PATH;
    delete process.env.CURSOR_RIPGREP_PATH;
    try {
      const resolved = resolveCursorRipgrepPath();
      assert.ok(resolved, "platform package should ship rg");
      assert.match(basename(resolved), /^rg(\.exe)?$/);
      assert.match(resolved, /@cursor[/\\]sdk-/);
      ensureCursorSdkPlatformBinaries();
      assert.equal(process.env.CURSOR_RIPGREP_PATH, resolved);
    } finally {
      if (previous === undefined) {
        delete process.env.CURSOR_RIPGREP_PATH;
      } else {
        process.env.CURSOR_RIPGREP_PATH = previous;
      }
    }
  });
});
