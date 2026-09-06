const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { DeterministicDailyDigestProjector } = require("../dist");

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
      occurred_at: "2026-09-05T08:00:00.000Z",
      ingested_at: "2026-09-05T08:01:00.000Z",
      content_hash: HASH_A,
    },
    thread_id: "thread-1",
    actor_id: "actor-1",
    required_scope_ids: ["scope-1"],
    text: "Original update",
    ...overrides,
  };
}

function input(events, heads) {
  return {
    org_id: "example-org",
    utc_date: "2026-09-05",
    generation: "daily-digest-d0-v1",
    source: {
      read_epoch: "authority:1",
      recorded_at: "2026-09-06T00:00:00.000Z",
      lifecycle_complete: true,
      lifecycle_heads: heads,
      events,
    },
  };
}

describe("deterministic daily digest projector", () => {
  it("uses the current revised head, retains lifecycle evidence, and ignores tombstones", async () => {
    const create = sourceEvent();
    const revise = sourceEvent({
      event: {
        ...create.event, event_id: "event-2", operation: "revise", parent_event_id: "event-1",
        ingested_at: "2026-09-05T09:01:00.000Z", content_hash: HASH_B,
      },
      required_scope_ids: ["scope-2"], text: "Revised update",
    });
    const deleted = sourceEvent({
      event: { ...create.event, event_id: "event-3", external_id: "message-2" },
      text: "Deleted update",
    });
    const tombstone = sourceEvent({
      event: {
        ...deleted.event, event_id: "event-4", operation: "tombstone", parent_event_id: "event-3",
        ingested_at: "2026-09-05T10:01:00.000Z", content_hash: undefined,
      },
      text: undefined,
    });
    const projector = new DeterministicDailyDigestProjector();
    const value = await projector.project(input([tombstone, revise, create, deleted], [
      { source: "synthetic", external_id: "message-1", head_event_id: "event-2" },
      { source: "synthetic", external_id: "message-2", head_event_id: "event-4" },
    ]));

    assert.equal(value.kind, "daily_digest");
    assert.deepEqual(value.attrs.items, [{
      event_id: "event-2", thread_id: "thread-1", actor_id: "actor-1",
      occurred_at: "2026-09-05T08:00:00.000Z", text: "Revised update",
    }]);
    assert.deepEqual(value.required_scope_ids, ["scope-1", "scope-2"]);
    assert.deepEqual(value.input_refs.map((reference) => reference.event_id), ["event-1", "event-2"]);
  });

  it("has stable identity independent of source ordering and omits empty UTC days", async () => {
    const event = sourceEvent();
    const projector = new DeterministicDailyDigestProjector();
    const values = await Promise.all([
      projector.project(input([event], [{ source: "synthetic", external_id: "message-1", head_event_id: "event-1" }])),
      projector.project(input([event], [{ source: "synthetic", external_id: "message-1", head_event_id: "event-1" }])),
      projector.project({ ...input([event], [{ source: "synthetic", external_id: "message-1", head_event_id: "event-1" }]), utc_date: "2026-09-06" }),
    ]);
    assert.equal(values[0].id, values[1].id);
    assert.equal(values[0].body_hash, values[1].body_hash);
    assert.equal(values[2], null);
  });
});
