const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { createPostgresAdvisoryLease } = require("../dist/background-leader");

const connectionString = process.env.TEST_DATABASE_URL?.trim();
const describePg = connectionString ? describe : describe.skip;

describePg("postgres advisory background leader", () => {
  it("lets only one session hold the timer lock", async () => {
    const first = createPostgresAdvisoryLease(connectionString);
    const second = createPostgresAdvisoryLease(connectionString);
    try {
      assert.equal(await first.tryAcquire(), true);
      assert.equal(await first.held(), true);
      assert.equal(await second.tryAcquire(), false);
      await first.release();
      assert.equal(await first.held(), false);
      assert.equal(await second.tryAcquire(), true);
      assert.equal(await first.tryAcquire(), false);
    } finally {
      await first.release();
      await second.release();
    }
  });
});
