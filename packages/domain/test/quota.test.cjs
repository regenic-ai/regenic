const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  DEFAULT_QUOTA_TOKENS,
  DEFAULT_QUOTA_WINDOW_MS,
  InstallationQuotaBook,
  connectorQuotaFromEnv,
  normalizeConnectorQuota,
} = require("../dist");

describe("installation quota", () => {
  it("reads a single default from env, not a per-source table", () => {
    assert.deepEqual(connectorQuotaFromEnv({}), {
      tokens: DEFAULT_QUOTA_TOKENS,
      window_ms: DEFAULT_QUOTA_WINDOW_MS,
    });
    assert.deepEqual(
      connectorQuotaFromEnv({
        REGENIC_CONNECTOR_QUOTA_TOKENS: "0",
        REGENIC_CONNECTOR_QUOTA_WINDOW_MS: "120000",
      }),
      { tokens: 0, window_ms: 120_000 },
    );
  });

  it("lets a connector declare a tighter budget", () => {
    assert.deepEqual(
      normalizeConnectorQuota(
        { tokens: 2 },
        { tokens: 60, window_ms: 60_000 },
      ),
      { tokens: 2, window_ms: 60_000 },
    );
  });

  it("throttles one install without spending another install's tokens", () => {
    let now = 1_000;
    const book = new InstallationQuotaBook(
      { tokens: 2, window_ms: 60_000 },
      () => now,
    );
    assert.equal(book.tryConsume("a"), true);
    assert.equal(book.tryConsume("a"), true);
    assert.equal(book.tryConsume("a"), false);
    assert.equal(book.tryConsume("b"), true);
    now += 60_000;
    assert.equal(book.tryConsume("a"), true);
  });

  it("disables the bucket when tokens is 0", () => {
    const book = new InstallationQuotaBook({ tokens: 0, window_ms: 60_000 });
    assert.equal(book.tryConsume("a"), true);
    assert.equal(book.tryConsume("a"), true);
  });
});
