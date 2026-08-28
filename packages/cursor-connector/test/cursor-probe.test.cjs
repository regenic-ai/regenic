const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  CURSOR_KEY_INVALID_HINT,
  CURSOR_KEY_MISSING_HINT,
  CURSOR_KEY_READY_HINT,
  cursorApiCatalogHint,
  cursorAgentDriver,
  probeCursorCatalog,
  resetCursorProbeCache,
} = require("../dist");

describe("Cursor catalog probe", () => {
  it("tells the user to set or replace CURSOR_API_KEY", () => {
    assert.equal(
      cursorApiCatalogHint({ present: false, ready: false }),
      CURSOR_KEY_MISSING_HINT,
    );
    assert.equal(
      cursorApiCatalogHint({ present: true, ready: false }),
      CURSOR_KEY_INVALID_HINT,
    );
    assert.equal(
      cursorApiCatalogHint({ present: true, ready: true }),
      CURSOR_KEY_READY_HINT,
    );
  });

  it("does not call Cursor when the env key is missing", async () => {
    resetCursorProbeCache();
    let called = false;
    const probe = await probeCursorCatalog({
      env: {},
      now: () => 1,
      async fetch() {
        called = true;
        throw new Error("should not run");
      },
    });
    assert.equal(called, false);
    assert.equal(probe.services["cursor-api"].ready, false);
    assert.match(probe.services["cursor-api"].hint, /Paste a Cursor API key/);
    assert.equal(typeof cursorAgentDriver.probeCatalog, "function");
    resetCursorProbeCache();
  });

  it("marks the key ready after GET /v1/me succeeds", async () => {
    resetCursorProbeCache();
    const urls = [];
    const probe = await probeCursorCatalog({
      env: {
        CURSOR_API_KEY: "key-1",
        REGENIC_CURSOR_API_BASE: "https://api.cursor.test",
      },
      now: () => 1,
      async fetch(url) {
        urls.push(String(url));
        return {
          ok: true,
          status: 200,
          async json() {
            return { apiKeyName: "local" };
          },
          async text() {
            return "{}";
          },
        };
      },
    });
    assert.deepEqual(urls, ["https://api.cursor.test/v1/me"]);
    assert.equal(probe.services["cursor-api"].ready, true);
    assert.equal(probe.services["cursor-api"].hint, CURSOR_KEY_READY_HINT);
    resetCursorProbeCache();
  });
});
