const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { DeterministicDailyDigestProjector } = require("../dist");
const { DEFAULT_DAILY_DIGEST_POLICY } = require("@regenic/domain");

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

  it("retains a high role-tier signal even without urgency or importance hints", async () => {
    const executive = sourceEvent({
      event: { ...sourceEvent().event, event_id: "event-executive", external_id: "executive-1" },
      thread_id: "thread-executive", weight_hints: { role_tier: 3.5 },
      text: "Review the launch position.",
    });
    const projector = new DeterministicDailyDigestProjector();
    const value = await projector.project(input([executive], [
      { source: "synthetic", external_id: "executive-1", head_event_id: "event-executive" },
    ]));

    assert.deepEqual(value.attrs.directions, [{
      direction: "product",
      items: [{
        item_kind: "hypothesis", score: 0,
        event_id: "event-executive", thread_id: "thread-executive", actor_id: "actor-1",
        occurred_at: "2026-09-05T08:00:00.000Z", text: "Review the launch position.",
      }],
    }]);
  });

  it("classifies a starter lexicon signal as bad news without trusted attrs", async () => {
    const outage = sourceEvent({
      event: { ...sourceEvent().event, event_id: "event-outage", external_id: "outage-1" },
      thread_id: "thread-outage", weight_hints: {}, text: "Production outage is blocking checkout.",
    });
    const projector = new DeterministicDailyDigestProjector();
    const value = await projector.project(input([outage], [
      { source: "synthetic", external_id: "outage-1", head_event_id: "event-outage" },
    ]));

    assert.deepEqual(value.attrs.directions, [{
      direction: "product",
      items: [{
        item_kind: "bad_news", score: 0,
        event_id: "event-outage", thread_id: "thread-outage", actor_id: "actor-1",
        occurred_at: "2026-09-05T08:00:00.000Z", text: "Production outage is blocking checkout.",
      }],
    }]);
  });

  it("replaces opposing high-tier direction signals with one clarify request", async () => {
    const support = sourceEvent({
      event: { ...sourceEvent().event, event_id: "event-support", external_id: "support-1" },
      thread_id: "thread-support", weight_hints: { urgency: 1, importance: 1, role_tier: 4 },
      attrs: { stance: "support" }, text: "Proceed with the launch",
    });
    const oppose = sourceEvent({
      event: { ...sourceEvent().event, event_id: "event-oppose", external_id: "oppose-1" },
      thread_id: "thread-oppose", weight_hints: { urgency: 1, importance: 1, role_tier: 4 },
      attrs: { stance: "oppose" }, text: "Delay the launch",
    });
    const projector = new DeterministicDailyDigestProjector();
    const value = await projector.project(input([support, oppose], [
      { source: "synthetic", external_id: "support-1", head_event_id: "event-support" },
      { source: "synthetic", external_id: "oppose-1", head_event_id: "event-oppose" },
    ]));

    assert.deepEqual(value.attrs.directions, [{
      direction: "product",
      items: [{
        item_kind: "clarify_request", score: 5,
        event_id: "event-oppose", thread_id: "thread-oppose", actor_id: "actor-1",
        occurred_at: "2026-09-05T08:00:00.000Z", text: "Delay the launch",
        conflicts: ["event-oppose", "event-support"],
      }],
    }]);
    assert.deepEqual(value.input_refs.map((reference) => reference.event_id), [
      "event-oppose", "event-support",
    ]);
    assert.deepEqual(value.required_scope_ids, ["scope-1"]);
  });

  it("applies a custom policy to directions, quotas, and bad-news terms", async () => {
    const watchlist = sourceEvent({
      event: { ...sourceEvent().event, event_id: "event-watch", external_id: "watch-1" },
      thread_id: "thread-watch", weight_hints: {}, text: "Watchlist issue requires attention.",
    });
    const sales = sourceEvent({
      event: { ...sourceEvent().event, event_id: "event-sales", external_id: "sales-1" },
      thread_id: "thread-sales", direction_tags: ["sales"], weight_hints: { evidence_class: "metric" },
    });
    const policy = {
      ...DEFAULT_DAILY_DIGEST_POLICY,
      enabled_directions: ["product"],
      max_items_per_direction: 1,
      bad_news_terms: ["watchlist"],
    };
    const projector = new DeterministicDailyDigestProjector();
    const value = await projector.project({
      ...input([watchlist, sales], [
        { source: "synthetic", external_id: "watch-1", head_event_id: "event-watch" },
        { source: "synthetic", external_id: "sales-1", head_event_id: "event-sales" },
      ]),
      policy,
    });
    assert.deepEqual(value.attrs.directions, [{
      direction: "product",
      items: [{
        item_kind: "bad_news", score: 0,
        event_id: "event-watch", thread_id: "thread-watch", actor_id: "actor-1",
        occurred_at: "2026-09-05T08:00:00.000Z", text: "Watchlist issue requires attention.",
      }],
    }]);
  });

  it("reports eligible high-signal heads omitted by the direction quota", async () => {
    const selected = sourceEvent({
      event: { ...sourceEvent().event, event_id: "event-selected", external_id: "selected-1" },
      thread_id: "thread-selected", weight_hints: { urgency: 1, importance: 1 },
    });
    const omitted = sourceEvent({
      event: { ...sourceEvent().event, event_id: "event-omitted", external_id: "omitted-1" },
      thread_id: "thread-omitted", weight_hints: { urgency: 0.8, importance: 0.8 },
    });
    const projector = new DeterministicDailyDigestProjector();
    const result = await projector.projectWithCoverage({
      ...input([omitted, selected], [
        { source: "synthetic", external_id: "selected-1", head_event_id: "event-selected" },
        { source: "synthetic", external_id: "omitted-1", head_event_id: "event-omitted" },
      ]),
      policy: { ...DEFAULT_DAILY_DIGEST_POLICY, max_items_per_direction: 1 },
    });
    assert.equal(result.proposal.attrs.directions[0].items[0].event_id, "event-selected");
    assert.deepEqual(result.omitted_event_ids, ["event-omitted"]);
  });

  it("selects events by the organization's local date and records UTC bounds", async () => {
    const lateUtc = sourceEvent({
      event: {
        ...sourceEvent().event,
        event_id: "event-shanghai",
        external_id: "shanghai-1",
        occurred_at: "2026-09-07T16:30:00.000Z",
      },
      weight_hints: { urgency: 1, importance: 1 },
    });
    const projector = new DeterministicDailyDigestProjector();
    const value = await projector.project({
      ...input([lateUtc], [{ source: "synthetic", external_id: "shanghai-1", head_event_id: "event-shanghai" }]),
      utc_date: "2026-09-08",
      policy: { ...DEFAULT_DAILY_DIGEST_POLICY, time_zone: "Asia/Shanghai" },
    });
    assert.equal(value.attrs.time_zone, "Asia/Shanghai");
    assert.equal(value.attrs.utc_start, "2026-09-07T16:00:00.000Z");
    assert.equal(value.attrs.utc_end, "2026-09-08T16:00:00.000Z");
    assert.equal(value.attrs.directions[0].items[0].event_id, "event-shanghai");
  });
});
