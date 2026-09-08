const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  MemoryBlobStore,
  MemoryContextArtifactStore,
} = require("@regenic/domain");
const { DailyDigestProjectionCoordinator } = require("../dist");

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function sourceEvent(overrides = {}) {
  return {
    event: {
      event_id: "event-1",
      org_id: "example-org",
      source: "synthetic",
      external_id: "message-1",
      operation: "create",
      occurred_at: "2026-09-07T08:00:00.000Z",
      ingested_at: "2026-09-07T08:01:00.000Z",
      content_hash: HASH_A,
    },
    thread_id: "thread-1",
    actor_id: "actor-1",
    required_scope_ids: ["scope-1"],
    direction_tags: ["product"],
    weight_hints: { urgency: 1, importance: 1 },
    text: "Initial signal",
    ...overrides,
  };
}

describe("DailyDigestProjectionCoordinator", () => {
  it("supersedes only a changed proposed digest for the same UTC period", async () => {
    const artifacts = new MemoryContextArtifactStore();
    const blobs = new MemoryBlobStore();
    let events = [sourceEvent()];
    const source = {
      async openRead() {
        return {
          read_epoch: "authority:1",
          recorded_at: "2026-09-07T12:00:00.000Z",
          lifecycle_complete: true,
          lifecycle_heads: [{ source: "synthetic", external_id: "message-1", head_event_id: events.at(-1).event.event_id }],
          events,
        };
      },
      async materialize(values) { return values; },
    };
    const coordinator = new DailyDigestProjectionCoordinator(source, artifacts, blobs);
    const first = await coordinator.projectDailyDigest({
      org_id: "example-org", utc_date: "2026-09-07",
    });
    events = [
      events[0],
      sourceEvent({
        event: {
          ...events[0].event,
          event_id: "event-2",
          operation: "revise",
          parent_event_id: "event-1",
          ingested_at: "2026-09-07T09:00:00.000Z",
          content_hash: HASH_B,
        },
        weight_hints: { urgency: 1, importance: 2 },
        text: "Revised signal",
      }),
    ];
    const second = await coordinator.projectDailyDigest({
      org_id: "example-org", utc_date: "2026-09-07",
    });

    assert.notEqual(first.artifact_id, second.artifact_id);
    assert.equal((await artifacts.getArtifactState("example-org", first.artifact_id)).status, "superseded");
    assert.equal((await artifacts.getArtifactState("example-org", second.artifact_id)).status, "proposed");
    assert.equal((await artifacts.getArtifact("example-org", second.artifact_id)).supersedes_id, first.artifact_id);
  });
});
