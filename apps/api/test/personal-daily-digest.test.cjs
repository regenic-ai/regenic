const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { PersonalDailyDigestService } = require("../dist/personal-daily-digest.service");
const {
  noteInteractiveReadFinished,
  resetInteractiveGate,
} = require("../dist/personal-interactive-gate");

function fixture(projectDailyDigest) {
  const calls = { enqueue: [], project: [], complete: [], fail: [] };
  const job = {
    id: "daily-job-1", org_id: "example-org", utc_date: "2026-09-07",
    generation: "daily-digest-d0-v1", attempts: 1,
  };
  let claimed = false;
  const jobs = {
    async enqueueDailyDigestJob(input) { calls.enqueue.push(input); return job; },
    async claimDailyDigestJobs() { return claimed ? [] : (claimed = true, [job]); },
    async completeDailyDigestJob(input) { calls.complete.push(input); return true; },
    async failDailyDigestJob(input) { calls.fail.push(input); return true; },
  };
  const host = { get(name) {
    if (name === "daily-digest-jobs") return jobs;
    if (name === "context-daily-digests") return { async projectDailyDigest(input) {
      calls.project.push(input);
      return projectDailyDigest(input);
    } };
    throw new Error(`unexpected ${name}`);
  } };
  noteInteractiveReadFinished();
  return {
    calls,
    service: new PersonalDailyDigestService({
      isReady: () => true, requireHost: () => host, orgId: () => "example-org",
    }),
  };
}

describe("PersonalDailyDigestService", () => {
  it("enqueues the UTC day once and completes the durable job", async () => {
    const { service, calls } = fixture(async () => ({ input_event_count: 1 }));
    await service.runOnce(new Date("2026-09-07T12:00:00.000Z"));
    assert.deepEqual(calls.enqueue, [{
      org_id: "example-org", utc_date: "2026-09-07", generation: "daily-digest-d0-v1",
      created_at: "2026-09-07T12:00:00.000Z",
    }]);
    assert.equal(calls.project.length, 1);
    assert.equal(calls.complete.length, 1);
    await service.runOnce(new Date("2026-09-07T12:01:00.000Z"));
    assert.equal(calls.project.length, 1);
    await service.onModuleDestroy();
    resetInteractiveGate();
  });

  it("persists retryable failure when projection fails", async () => {
    const { service, calls } = fixture(async () => { throw new Error("offline"); });
    await service.runOnce(new Date("2026-09-07T12:00:00.000Z"));
    assert.equal(calls.complete.length, 0);
    assert.equal(calls.fail.length, 1);
    assert.equal(calls.fail[0].error_code, "Error");
    assert.equal(calls.fail[0].next_retry_at, "2026-09-07T12:00:01.000Z");
    await service.onModuleDestroy();
    resetInteractiveGate();
  });
});