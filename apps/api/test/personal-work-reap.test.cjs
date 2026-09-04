const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  handleFromInboxEnd,
  isStaleWork,
  scanInboxTurns,
  shouldForceReap,
  workAgeMs,
  workReapStaleMs,
} = require("../dist/personal-work-reap");

describe("work reap helpers", () => {
  it("treats work older than the stale window as stale", () => {
    const now = Date.parse("2026-09-04T05:00:00.000Z");
    assert.equal(workAgeMs("2026-09-04T04:56:00.000Z", now), 4 * 60 * 1000);
    assert.equal(isStaleWork("2026-09-04T04:57:30.000Z", now, 3 * 60 * 1000), false);
    assert.equal(isStaleWork("2026-09-04T04:56:00.000Z", now, 3 * 60 * 1000), true);
  });

  it("reads the stale window from env with a 30s floor", () => {
    assert.equal(workReapStaleMs({}), 3 * 60 * 1000);
    assert.equal(workReapStaleMs({ REGENIC_WORK_REAP_STALE_MS: "120000" }), 120000);
    assert.equal(workReapStaleMs({ REGENIC_WORK_REAP_STALE_MS: "1000" }), 3 * 60 * 1000);
  });

  it("reaps from any ended thread_status even if live is still working", () => {
    const scan = scanInboxTurns([
      { status: true, turn: { state: "open" }, activity: "working" },
      { status: true, turn: { state: "ended", ok: true, reason: "completed" }, text: "SEND_AND_CLOSE" },
      { status: false, text: "done" },
    ]);
    assert.equal(scan.liveTurn, "open");
    assert.equal(scan.liveActivity, "working");
    assert.equal(scan.inboxEnded, true);
    assert.equal(scan.endedSummary, "SEND_AND_CLOSE");
    assert.equal(shouldForceReap({ handleStatus: "running", inboxEnded: true }), true);
    assert.equal(shouldForceReap({ handleStatus: "waiting_human", inboxEnded: true }), false);
    assert.equal(shouldForceReap({ handleStatus: "running", inboxEnded: false }), false);
  });

  it("builds a completed handle from the ended inbox row", () => {
    const handle = handleFromInboxEnd(
      { id: "run-1", agent_thread_id: "dsh:session:abc" },
      {
        liveTurn: "open",
        liveActivity: "working",
        inboxEnded: true,
        endedOk: true,
        endedReason: "completed",
        endedSummary: "APPROVED",
      },
    );
    assert.equal(handle.status, "completed");
    assert.equal(handle.result?.summary, "APPROVED");
    assert.equal(handle.agent_thread_id, "dsh:session:abc");
  });
});
