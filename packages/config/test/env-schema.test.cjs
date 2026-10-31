const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { loadEnv } = require("../dist");

describe("environment schema compatibility", () => {
  it("preserves defaults, coercion, catch fallbacks and unknown-key stripping", () => {
    const defaults = loadEnv({});
    assert.equal(defaults.NODE_ENV, "development");
    assert.equal(defaults.PORT, 3000);
    assert.equal(defaults.REGENIC_MODEL_TIMEOUT_MS, 30_000);
    assert.equal(defaults.REGENIC_MODEL_MAX_RESPONSE_BYTES, 1_048_576);
    const parsed = loadEnv({
      PORT: "8080",
      REGENIC_MODEL_TIMEOUT_MS: "300000",
      REGENIC_MODEL_MAX_RESPONSE_BYTES: "1024",
      UNKNOWN: "discard",
    });
    assert.equal(parsed.PORT, 8080);
    assert.equal(parsed.REGENIC_MODEL_TIMEOUT_MS, 300_000);
    assert.equal(parsed.REGENIC_MODEL_MAX_RESPONSE_BYTES, 1_024);
    assert.equal("UNKNOWN" in parsed, false);
    for (const value of ["invalid", "0", "300001", "1.5"]) {
      assert.equal(loadEnv({ REGENIC_MODEL_TIMEOUT_MS: value }).REGENIC_MODEL_TIMEOUT_MS, 30_000);
    }
  });

  it("still reports invalid required settings as schema errors", () => {
    for (const env of [{ PORT: "invalid" }, { PORT: "0" }, { NODE_ENV: "invalid" }]) {
      assert.throws(() => loadEnv(env), (error) =>
        error.name === "ZodError" && error.issues.length === 1
        && error.issues[0].path[0] === Object.keys(env)[0]);
    }
  });
});
