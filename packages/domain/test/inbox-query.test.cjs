const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  escapeLikeLiteral,
  formatInboxDigest,
  headsByThread,
  inboxDigest,
  normalizeInboxLimit,
  selectInboxItems,
  summarizeInboxItems,
  takeRecentInboxItems,
  threadExternalIdLike,
} = require("../dist");

describe("inbox query helpers", () => {
  it("counts current work by conversation, not every event", () => {
    const items = [
      {
        decision: { disposition: "current_work" },
        event: {
          id: "e1",
          source: "dsh",
          external_id: "session-x:1",
          ingested_at: "2026-08-23T00:00:00.000Z",
        },
      },
      {
        decision: { disposition: "current_work" },
        event: {
          id: "e2",
          source: "dsh",
          external_id: "session-x:2",
          ingested_at: "2026-08-23T00:00:01.000Z",
        },
      },
    ];
    const summary = summarizeInboxItems(items);
    assert.equal(summary.count, 1);
    assert.equal(
      summary.digest,
      formatInboxDigest({
        count: 1,
        latest_at: "2026-08-23T00:00:01.000Z",
        latest_id: "e2",
        pref_count: 0,
        pref_updated_at: "",
      }),
    );
  });

  it("changes the digest when a conversation pref is saved", () => {
    const items = [
      {
        event: {
          id: "e1",
          source: "dsh",
          external_id: "session-x:1",
          ingested_at: "2026-08-23T00:00:00.000Z",
        },
      },
    ];
    const before = inboxDigest(items);
    const after = inboxDigest(items, [{ updated_at: "2026-08-23T00:01:00.000Z" }]);
    assert.notEqual(before, after);
    assert.match(after, /:1:2026-08-23T00:01:00.000Z$/);
  });

  it("changes the digest when work or write-back updates", () => {
    const before = formatInboxDigest({
      count: 1,
      latest_at: "2026-08-23T00:00:00.000Z",
      latest_id: "e1",
      pref_count: 0,
      pref_updated_at: "",
    });
    const after = formatInboxDigest({
      count: 1,
      latest_at: "2026-08-23T00:00:00.000Z",
      latest_id: "e1",
      pref_count: 0,
      pref_updated_at: "",
      work_updated_at: "2026-08-23T00:02:00.000Z",
    });
    assert.notEqual(before, after);
    assert.match(after, /&w=2026-08-23T00:02:00.000Z$/);
  });

  it("escapes LIKE wildcards in a thread target prefix", () => {
    assert.equal(escapeLikeLiteral("a_b%c\\d"), "a\\_b\\%c\\\\d");
    assert.equal(threadExternalIdLike("a_b"), "a\\_b:%");
  });

  it("keeps the last visible message as the head and drops a newer working marker", () => {
    const visible = {
      decision: {
        disposition: "current_work",
        reason_codes: ["actionable"],
      },
      event: {
        id: "e1",
        source: "dsh",
        external_id: "session-x:1",
        occurred_at: "2026-08-22T10:43:00.000Z",
        ingested_at: "2026-08-22T10:43:00.000Z",
      },
    };
    const working = {
      decision: {
        disposition: "current_work",
        reason_codes: ["thread_status"],
      },
      event: {
        id: "e2",
        source: "dsh",
        external_id: "session-x:2",
        occurred_at: "2026-08-22T10:44:00.000Z",
        ingested_at: "2026-08-22T10:44:00.000Z",
      },
    };
    const other = {
      decision: {
        disposition: "current_work",
        reason_codes: ["actionable"],
      },
      event: {
        id: "e3",
        source: "dsh",
        external_id: "session-z:1",
        occurred_at: "2026-08-22T12:00:00.000Z",
        ingested_at: "2026-08-22T12:00:00.000Z",
      },
    };
    const heads = headsByThread([visible, working, other]);
    assert.deepEqual(
      heads.map((item) => item.event.id).sort(),
      ["e1", "e3"],
    );
    const selected = selectInboxItems([visible, working, other], { heads: true });
    assert.deepEqual(
      selected.map((item) => item.event.id).sort(),
      ["e1", "e3"],
    );
  });

  it("uses a sibling outside current work as the list face", () => {
    const noise = {
      decision: {
        disposition: "outside_current_work",
        reason_codes: ["noise"],
      },
      event: {
        id: "e1",
        source: "dsh",
        external_id: "session-x:1",
        occurred_at: "2026-08-22T10:43:00.000Z",
        ingested_at: "2026-08-22T10:43:00.000Z",
      },
    };
    const working = {
      decision: {
        disposition: "current_work",
        reason_codes: ["thread_status"],
      },
      event: {
        id: "e2",
        source: "dsh",
        external_id: "session-x:2",
        occurred_at: "2026-08-22T10:44:00.000Z",
        ingested_at: "2026-08-22T10:44:00.000Z",
      },
    };
    const heads = selectInboxItems([noise, working], { heads: true });
    assert.deepEqual(
      heads.map((item) => item.event.id),
      ["e1"],
    );
  });

  it("does not list a conversation that is only a working marker", () => {
    const working = {
      decision: {
        disposition: "current_work",
        reason_codes: ["thread_status"],
      },
      event: {
        id: "e2",
        source: "dsh",
        external_id: "session-empty:2",
        occurred_at: "2026-08-22T10:43:00.000Z",
        ingested_at: "2026-08-22T10:43:00.000Z",
      },
    };
    assert.deepEqual(headsByThread([working]), []);
    assert.deepEqual(selectInboxItems([working], { heads: true }), []);
    assert.equal(summarizeInboxItems([working]).count, 0);
  });

  it("takes the latest page and then the page before that cursor", () => {
    const items = [1, 2, 3, 4].map((n) => ({
      decision: { disposition: "current_work" },
      event: {
        id: `e${n}`,
        org_id: "org",
        source: "feishu",
        external_id: `oc_1:om_${n}`,
        occurred_at: `2026-08-23T00:0${n}:00.000Z`,
        ingested_at: `2026-08-23T00:0${n}:00.000Z`,
      },
    }));
    const recent = selectInboxItems(items, { limit: 2 });
    assert.deepEqual(
      recent.map((item) => item.event.id),
      ["e3", "e4"],
    );
    const older = selectInboxItems(items, {
      before: recent[0].event.occurred_at,
      before_id: recent[0].event.id,
      limit: 2,
    });
    assert.deepEqual(
      older.map((item) => item.event.id),
      ["e1", "e2"],
    );
    assert.deepEqual(
      takeRecentInboxItems([items[3], items[0], items[2], items[1]], { limit: 2 }).map(
        (item) => item.event.id,
      ),
      ["e3", "e4"],
    );
    assert.equal(normalizeInboxLimit(500), 200);
    assert.equal(normalizeInboxLimit("12"), 12);
    assert.equal(normalizeInboxLimit("nope"), undefined);
    assert.deepEqual(
      selectInboxItems(items, { heads: true, limit: 1 }).map((item) => item.event.id),
      ["e4"],
    );
  });
});
