const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  DEFAULT_QUOTA_TOKENS,
  DEFAULT_QUOTA_WINDOW_MS,
  InstallationQuotaBook,
  connectorQuotaFromEnv,
  normalizeConnectorQuota,
  reservedInteractiveTokens,
  runInSyncLane,
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

  it("reserves tokens so live backfill cannot starve interactive", () => {
    const book = new InstallationQuotaBook({ tokens: 5, window_ms: 60_000 });
    assert.equal(reservedInteractiveTokens(5), 1);
    assert.equal(book.tryConsume("a", undefined, "live"), true);
    assert.equal(book.tryConsume("a", undefined, "history"), true);
    assert.equal(book.tryConsume("a", undefined, "live"), true);
    assert.equal(book.tryConsume("a", undefined, "history"), true);
    assert.equal(book.tryConsume("a", undefined, "live"), false);
    assert.equal(book.tryConsume("a", undefined, "interactive"), true);
  });

  it("reads the current lane when the caller omits it", async () => {
    const book = new InstallationQuotaBook({ tokens: 5, window_ms: 60_000 });
    book.tryConsume("a", undefined, "live");
    book.tryConsume("a", undefined, "live");
    book.tryConsume("a", undefined, "live");
    book.tryConsume("a", undefined, "live");
    await runInSyncLane("interactive", () => {
      assert.equal(book.tryConsume("a"), true);
    });
  });

  it("applies an explicit user quota without refilling on unchanged settings and restores hints", () => {
    const book = new InstallationQuotaBook({ tokens: 2, window_ms: 60_000 }, () => 1_000);
    const hint = { tokens: 1, window_ms: 60_000 };
    assert.equal(book.tryConsume("a", hint), true);
    assert.equal(book.tryConsume("a", hint), false);
    book.configure({ tokens: 3, window_ms: 60_000 });
    for (let count = 0; count < 3; count++) assert.equal(book.tryConsume("a", hint), true);
    book.configure({ tokens: 3, window_ms: 60_000 });
    assert.equal(book.tryConsume("a", hint), false);
    assert.equal(book.tryConsume("b", hint), true);
    book.configure({ tokens: 0, window_ms: 60_000 });
    for (let count = 0; count < 10; count++) assert.equal(book.tryConsume("a", hint), true);
    book.configure();
    assert.equal(book.tryConsume("a", hint), true);
    assert.equal(book.tryConsume("a", hint), false);
  });

  it("prefers declared limits.rate over the quota hint", () => {
    const book = new InstallationQuotaBook({ tokens: 60, window_ms: 60_000 }, () => 1_000);
    book.declare("a", { rate: { tokens: 1, window_ms: 60_000 } });
    assert.equal(book.tryConsume("a", { tokens: 10, window_ms: 60_000 }), true);
    assert.equal(book.tryConsume("a", { tokens: 10, window_ms: 60_000 }), false);
    assert.deepEqual(book.limits("a").effective.rate, { tokens: 1, window_ms: 60_000 });
  });

  it("lets a runtime adjustment tighten but never loosen a user quota", () => {
    const book = new InstallationQuotaBook({ tokens: 60, window_ms: 60_000 }, () => 1_000);
    book.configure({ tokens: 3, window_ms: 60_000 });
    book.adjust("a", { rate: { tokens: 1, window_ms: 60_000 } });
    assert.equal(book.tryConsume("a"), true);
    assert.equal(book.tryConsume("a"), false);
    book.adjust("b", { rate: { tokens: 100, window_ms: 60_000 } });
    assert.deepEqual(book.limits("b").effective.rate, { tokens: 3, window_ms: 60_000 });
    book.configure({ tokens: 0, window_ms: 60_000 });
    assert.deepEqual(book.limits("b").effective.rate, { tokens: 100, window_ms: 60_000 });
  });

  it("gates concurrency per installation and restores the declaration on clear", () => {
    const book = new InstallationQuotaBook({ tokens: 0, window_ms: 60_000 });
    book.declare("a", { max_concurrency: 1, page_size: 50 });
    const release = book.tryAcquireSlot("a");
    assert.equal(typeof release, "function");
    assert.equal(book.tryAcquireSlot("a"), undefined);
    assert.equal(typeof book.tryAcquireSlot("b"), "function");
    release();
    release();
    assert.equal(book.limits("a").inflight, 0);
    book.adjust("a", { page_size: 5 });
    assert.equal(book.pageSize("a"), 5);
    assert.deepEqual(book.limits("a").effective, {
      max_concurrency: 1,
      page_size: 5,
      rate: { tokens: 0, window_ms: 60_000 },
    });
    book.adjust("a");
    assert.equal(book.pageSize("a"), 50);
  });

  it("drops out-of-range declared limits instead of failing the connector", () => {
    const book = new InstallationQuotaBook({ tokens: 0, window_ms: 60_000 });
    book.declare("a", { max_concurrency: 0, page_size: 1.5, rate: { tokens: 5, window_ms: 1 } });
    assert.equal(book.limits("a").declared, undefined);
    assert.equal(typeof book.tryAcquireSlot("a"), "function");
  });
});
