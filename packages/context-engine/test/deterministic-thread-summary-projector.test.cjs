const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  DeterministicThreadSummaryProjector,
} = require("../dist");

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
      occurred_at: "2026-08-30T00:00:00.000Z",
      ingested_at: "2026-08-30T00:00:01.000Z",
      content_hash: HASH_A,
    },
    thread_id: "thread-1",
    actor_id: "actor-1",
    required_scope_ids: ["scope-1"],
    text: "Original text",
    ...overrides,
  };
}

function input(sourceEvents, lifecycleHeads) {
  return {
    org_id: "example-org",
    generation: "continuous-v1",
    read_epoch: "authority:4",
    recorded_at: "2026-08-30T00:04:00.000Z",
    evidence: sourceEvents.map((value) => ({
      event_id: value.event.event_id,
      source: value.event.source,
      external_id: value.event.external_id,
      operation: value.event.operation,
      occurred_at: value.event.occurred_at,
      ...(value.event.content_hash ? { content_hash: value.event.content_hash } : {}),
    })),
    source_events: sourceEvents,
    lifecycle_heads: lifecycleHeads,
  };
}

describe("deterministic thread summary projector", () => {
  it("uses revised lifecycle heads and excludes tombstoned messages", async () => {
    const create = sourceEvent();
    const revise = sourceEvent({
      event: {
        ...create.event,
        event_id: "event-2",
        operation: "revise",
        parent_event_id: "event-1",
        ingested_at: "2026-08-30T00:01:01.000Z",
        content_hash: HASH_B,
      },
      required_scope_ids: ["scope-2"],
      text: "Revised text",
    });
    const removed = sourceEvent({
      event: {
        ...create.event,
        event_id: "event-3",
        external_id: "message-2",
        ingested_at: "2026-08-30T00:02:01.000Z",
      },
      actor_id: "actor-2",
      text: "Must disappear",
    });
    const tombstone = sourceEvent({
      event: {
        ...removed.event,
        event_id: "event-4",
        operation: "tombstone",
        parent_event_id: "event-3",
        ingested_at: "2026-08-30T00:03:01.000Z",
        content_hash: undefined,
      },
      text: undefined,
    });
    const projector = new DeterministicThreadSummaryProjector();
    const projectionInput = input([create, revise, removed, tombstone], [
      { source: "synthetic", external_id: "message-1", head_event_id: "event-2" },
      { source: "synthetic", external_id: "message-2", head_event_id: "event-4" },
    ]);

    const [artifact] = await projector.project(projectionInput);
    assert.equal(artifact.kind, "thread_summary");
    assert.equal(artifact.status, "proposed");
    assert.equal(artifact.recorded_at, projectionInput.recorded_at);
    assert.deepEqual(artifact.required_scope_ids, ["scope-1", "scope-2"]);
    assert.equal(artifact.input_refs.length, 4);
    assert.deepEqual(artifact.attrs.messages, [{
      event_id: "event-2",
      actor_id: "actor-1",
      occurred_at: "2026-08-30T00:00:00.000Z",
      text: "Revised text",
    }]);
    assert.equal(artifact.attrs.message_count, 1);
  });

  it("produces byte-stable identity and body independent of input order", async () => {
    const first = sourceEvent();
    const second = sourceEvent({
      event: {
        ...first.event,
        event_id: "event-2",
        external_id: "message-2",
        occurred_at: "2026-08-30T00:01:00.000Z",
        ingested_at: "2026-08-30T00:01:01.000Z",
        content_hash: HASH_B,
      },
      actor_id: "actor-2",
      text: "Second text",
    });
    const heads = [
      { source: "synthetic", external_id: "message-1", head_event_id: "event-1" },
      { source: "synthetic", external_id: "message-2", head_event_id: "event-2" },
    ];
    const projector = new DeterministicThreadSummaryProjector();
    const [left] = await projector.project(input([first, second], heads));
    const [right] = await projector.project(input([second, first], [...heads].reverse()));

    assert.equal(left.id, right.id);
    assert.equal(left.input_hash, right.input_hash);
    assert.equal(left.body_hash, right.body_hash);
    assert.deepEqual(left.attrs, right.attrs);
  });
});
