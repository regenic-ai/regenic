const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  DeadlineExceededError,
  DEFAULT_POLL_TIMEOUT_MS,
  DEFAULT_SYNC_TIMEOUT_MS,
  connectorPollTimeoutMs,
  connectorSyncTimeoutMs,
  settleIsolated,
  withDeadline,
} = require("../dist");

describe("deadline", () => {
  it("returns the work when it finishes before the cutoff", async () => {
    assert.equal(await withDeadline(Promise.resolve("ok"), 50, "fast"), "ok");
  });

  it("does not impose a cutoff when timeout_ms is 0", async () => {
    assert.equal(await withDeadline(Promise.resolve("ok"), 0, "off"), "ok");
  });

  it("rejects with DeadlineExceededError after the cutoff", async () => {
    await assert.rejects(
      () => withDeadline(new Promise(() => {}), 20, "hang"),
      (error) => {
        assert.ok(error instanceof DeadlineExceededError);
        assert.equal(error.code, "deadline_exceeded");
        assert.equal(error.timeout_ms, 20);
        assert.match(error.message, /hang timed out after 20ms/);
        return true;
      },
    );
  });

  it("lets a fast install finish while another hangs", async () => {
    const seen = [];
    const started = Date.now();
    const errors = await settleIsolated(
      [
        () => new Promise(() => {}),
        async () => {
          seen.push("fast");
        },
      ],
      { timeoutMs: 40, label: (index) => `job ${index}` },
    );
    assert.deepEqual(seen, ["fast"]);
    assert.ok(Date.now() - started < 200);
    assert.equal(errors.length, 1);
    assert.ok(errors[0] instanceof DeadlineExceededError);
    assert.match(String(errors[0].message), /job 0 timed out/);
  });

  it("keeps a thrown install from blocking the others", async () => {
    const seen = [];
    const errors = await settleIsolated([
      async () => {
        throw new Error("slack down");
      },
      async () => {
        seen.push("feishu");
      },
    ]);
    assert.deepEqual(seen, ["feishu"]);
    assert.equal(errors.length, 1);
    assert.match(String(errors[0].message), /slack down/);
  });

  it("does not emit unhandledRejection when timed-out work later fails", async () => {
    const late = [];
    const onUnhandled = (error) => {
      late.push(error);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      let rejectWork;
      const work = new Promise((_, reject) => {
        rejectWork = reject;
      });
      await assert.rejects(
        () => withDeadline(work, 20, "hang"),
        DeadlineExceededError,
      );
      rejectWork(new Error("late failure"));
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.deepEqual(late, []);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("still rejects with the work error when it fails before the cutoff", async () => {
    await assert.rejects(
      () => withDeadline(Promise.reject(new Error("slack down")), 50, "fast"),
      /slack down/,
    );
  });

  it("reads poll and sync timeouts from env", () => {
    assert.equal(connectorPollTimeoutMs({}), DEFAULT_POLL_TIMEOUT_MS);
    assert.equal(connectorSyncTimeoutMs({}), DEFAULT_SYNC_TIMEOUT_MS);
    assert.equal(
      connectorPollTimeoutMs({ REGENIC_CONNECTOR_POLL_TIMEOUT_MS: "0" }),
      0,
    );
    assert.equal(
      connectorSyncTimeoutMs({ REGENIC_CONNECTOR_SYNC_TIMEOUT_MS: "500" }),
      1_000,
    );
    assert.equal(
      connectorPollTimeoutMs({ REGENIC_CONNECTOR_POLL_TIMEOUT_MS: "999999" }),
      120_000,
    );
  });
});
