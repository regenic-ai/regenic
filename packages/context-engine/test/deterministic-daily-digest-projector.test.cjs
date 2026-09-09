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
    direction_tags: ["product"],
    weight_hints: { urgency: 0.8, importance: 0.8 },
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
    assert.deepEqual(value.attrs.directions, [{
      direction: "product",
      items: [{
        item_kind: "hypothesis", score: 1.6,
        event_id: "event-2", thread_id: "thread-1", actor_id: "actor-1",
        occurred_at: "2026-09-05T08:00:00.000Z", text: "Revised update",
      }],
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

  it("uses controlled directions, folds threads by score, and reserves a bad-news seat", async () => {
    const lowerThreadUpdate = sourceEvent({
      event: { ...sourceEvent().event, event_id: "event-low", external_id: "thread-update" },
      weight_hints: { urgency: 0.7, importance: 0.8 },
    });
    const higherThreadUpdate = sourceEvent({
      event: {
        ...lowerThreadUpdate.event, event_id: "event-high", parent_event_id: "event-low",
        operation: "revise", ingested_at: "2026-09-05T08:02:00.000Z",
      },
      weight_hints: { urgency: 0.9, importance: 0.9 }, text: "Higher signal",
    });
    const metric = sourceEvent({
      event: { ...sourceEvent().event, event_id: "event-metric", external_id: "metric-1" },
      thread_id: "thread-metric", direction_tags: ["sales"],
      weight_hints: { evidence_class: "metric" }, text: "Revenue rose",
    });
    const badNews = sourceEvent({
      event: { ...sourceEvent().event, event_id: "event-risk", external_id: "risk-1" },
      thread_id: "thread-risk", direction_tags: ["sales"], weight_hints: {},
      attrs: { severity: "critical" }, text: "Customer outage",
    });
    const unknown = sourceEvent({
      event: { ...sourceEvent().event, event_id: "event-unknown", external_id: "unknown-1" },
      direction_tags: ["free-form"], weight_hints: { urgency: 1, importance: 1 },
    });
    const projector = new DeterministicDailyDigestProjector();
    const value = await projector.project(input(
      [lowerThreadUpdate, higherThreadUpdate, metric, badNews, unknown],
      [
        { source: "synthetic", external_id: "thread-update", head_event_id: "event-high" },
        { source: "synthetic", external_id: "metric-1", head_event_id: "event-metric" },
        { source: "synthetic", external_id: "risk-1", head_event_id: "event-risk" },
        { source: "synthetic", external_id: "unknown-1", head_event_id: "event-unknown" },
      ],
    ));

    assert.deepEqual(value.attrs.directions, [
      {
        direction: "product",
        items: [{
          item_kind: "hypothesis", score: 1.8,
          event_id: "event-high", thread_id: "thread-1", actor_id: "actor-1",
          occurred_at: "2026-09-05T08:00:00.000Z", text: "Higher signal",
        }],
      },
      {
        direction: "sales",
        items: [
          {
            item_kind: "metric_signal", score: 0,
            event_id: "event-metric", thread_id: "thread-metric", actor_id: "actor-1",
            occurred_at: "2026-09-05T08:00:00.000Z", text: "Revenue rose",
          },
          {
            item_kind: "bad_news", score: 0,
            event_id: "event-risk", thread_id: "thread-risk", actor_id: "actor-1",
            occurred_at: "2026-09-05T08:00:00.000Z", text: "Customer outage",
          },
        ],
      },
    ]);
    assert.deepEqual(value.input_refs.map((reference) => reference.event_id), [
      "event-low", "event-metric", "event-risk", "event-high",
    ]);
  });

  it("weights higher-evidence classes before otherwise equal hypotheses", async () => {
    const opinion = sourceEvent({
      event: { ...sourceEvent().event, event_id: "event-opinion", external_id: "opinion-1" },
      thread_id: "thread-opinion", weight_hints: { urgency: 0.8, importance: 0.8, evidence_class: "opinion" },
    });
    const demo = sourceEvent({
      event: { ...sourceEvent().event, event_id: "event-demo", external_id: "demo-1" },
      thread_id: "thread-demo", weight_hints: { urgency: 0.8, importance: 0.8, evidence_class: "demo" },
    });
    const projector = new DeterministicDailyDigestProjector();
    const value = await projector.project(input([opinion, demo], [
      { source: "synthetic", external_id: "opinion-1", head_event_id: "event-opinion" },
      { source: "synthetic", external_id: "demo-1", head_event_id: "event-demo" },
    ]));
    assert.deepEqual(value.attrs.directions[0].items.map((item) => [item.event_id, item.score]), [
      ["event-demo", 4.8], ["event-opinion", 1.6],
    ]);
  });
});
