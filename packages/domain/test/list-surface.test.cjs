const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  collectListSurfacePatches,
  effectiveHiddenReason,
  foldByHuman,
  foldByPolicy,
  listSurfacePatches,
  nextHiddenPref,
  normalizeInboxListView,
  unfold,
} = require("../dist");

describe("list surface", () => {
  it("does not reopen a policy-hidden thread for a tombstone disposition", () => {
    const event = {
      id: "deleted", org_id: "org", source: "source", external_id: "deleted",
      thread_id: "thread", operation: "tombstone", occurred_at: "t0", ingested_at: "t0",
    };
    const decision = {
      event_id: event.id, org_id: event.org_id, disposition: "current_work",
      layer: "L1_event", reason_codes: [], score: 1, decided_at: "t0",
    };
    assert.deepEqual(listSurfacePatches({
      orgId: "org", now: "t1", events: [event],
      dispositions: new Map([[event.id, decision]]),
      prefs: new Map([["thread", { hidden: true, hidden_reason: "policy", visibility_version: 0 }]]),
      onDesk: new Map([["thread", false]]),
    }), []);
  });

  it("maps leftover membership values onto the list view", () => {
    assert.equal(normalizeInboxListView("hidden"), "hidden");
    assert.equal(normalizeInboxListView("done"), "hidden");
    assert.equal(normalizeInboxListView("open"), "shown");
    assert.equal(normalizeInboxListView("shown"), "shown");
    assert.equal(normalizeInboxListView(undefined), "shown");
  });

  it("treats a hidden row without a reason as a human fold", () => {
    assert.equal(effectiveHiddenReason({ hidden: true, reason: null }), "human");
    assert.equal(effectiveHiddenReason({ hidden: false, reason: "policy" }), null);
  });

  it("keeps a human fold until the person shows it again", () => {
    assert.deepEqual(
      nextHiddenPref({
        hidden: true,
        reason: "human",
        onDesk: true,
        acceptedCurrentWork: true,
        acceptedTombstone: true,
      }),
      undefined,
    );
    assert.deepEqual(foldByPolicy({ hidden: true, reason: "human" }), undefined);
    assert.deepEqual(foldByHuman(), { hidden: true, reason: "human" });
    assert.deepEqual(unfold(), { hidden: false, reason: null });
  });

  it("lets policy folds reopen when new desk work arrives", () => {
    assert.deepEqual(
      nextHiddenPref({
        hidden: true,
        reason: "policy",
        onDesk: true,
        acceptedCurrentWork: true,
        acceptedTombstone: false,
      }),
      { hidden: false, reason: null },
    );
  });

  it("folds a tombstone that leaves the thread off the desk", () => {
    assert.deepEqual(
      nextHiddenPref({
        hidden: false,
        reason: null,
        onDesk: false,
        acceptedCurrentWork: false,
        acceptedTombstone: true,
      }),
      { hidden: true, reason: "policy" },
    );
    assert.deepEqual(
      nextHiddenPref({
        hidden: false,
        reason: null,
        onDesk: true,
        acceptedCurrentWork: false,
        acceptedTombstone: true,
      }),
      undefined,
    );
  });

  it("collects tombstone folds against the persisted conversation identity", async () => {
    const event = {
      id: "event-1", org_id: "org", source: "source", external_id: "message-1",
      thread_id: "source:conversation", operation: "tombstone",
      occurred_at: "t0", ingested_at: "t0",
    };
    const requested = [];
    const patches = await collectListSurfacePatches({
      async getEvent() { return event; },
      async getDisposition() { return null; },
      async getConversationPref(_org, thread) { requested.push(["pref", thread]); return null; },
      async listInbox(_org, query) { requested.push(["inbox", ...query.thread_ids]); return []; },
    }, "org", [event.id]);
    assert.deepEqual(requested, [
      ["pref", "source:conversation"], ["inbox", "source:conversation"],
    ]);
    assert.equal(patches.length, 1);
    assert.equal(patches[0].thread_id, "source:conversation");
    assert.deepEqual(patches[0].fold_current_tombstone_event_ids, [event.id]);
  });

  it("builds hide patches without writing the store", () => {
    const patches = listSurfacePatches({
      orgId: "org",
      now: "t1",
      events: [
        {
          id: "event-1",
          org_id: "org",
          source: "crm",
          external_id: "order-1",
          operation: "create",
          occurred_at: "t0",
          ingested_at: "t0",
        },
      ],
      dispositions: new Map([
        ["event-1", { event_id: "event-1", disposition: "current_work" }],
      ]),
      prefs: new Map([
        [
          "crm:order-1",
          {
            org_id: "org",
            thread_id: "crm:order-1",
            hidden: true,
            hidden_reason: "policy",
          },
        ],
      ]),
      onDesk: new Map([["crm:order-1", false]]),
    });
    assert.deepEqual(patches, [
      {
        org_id: "org",
        thread_id: "crm:order-1",
        hidden: false,
        expected_visibility_version: 0,
        updated_at: "t1",
        unfold_current_work_event_ids: ["event-1"],
      },
    ]);
  });

  it("does not rewrite an already policy-hidden thread", () => {
    assert.deepEqual(foldByPolicy({ hidden: true, reason: "policy" }), undefined);
    assert.deepEqual(foldByPolicy({ hidden: false, reason: null }), {
      hidden: true,
      reason: "policy",
    });
  });

  it("builds ingest folds from accepted events, not connector names", async () => {
    const events = new Map([
      [
        "gone",
        {
          id: "gone",
          org_id: "org",
          source: "crm",
          external_id: "order-1:1",
          operation: "tombstone",
        },
      ],
    ]);
    const store = {
      async getEvent(_orgId, id) {
        return events.get(id) ?? null;
      },
      async getDisposition() {
        return { disposition: "outside_current_work" };
      },
      async getConversationPref(_orgId, threadId) {
        assert.equal(threadId, "crm:order-1");
        return null;
      },
      async listInbox() {
        return [];
      },
    };
    const patches = await collectListSurfacePatches(store, "org", ["gone"]);
    assert.equal(patches.length, 1);
    assert.equal(patches[0].hidden, true);
    assert.deepEqual(patches[0].fold_current_tombstone_event_ids, ["gone"]);
  });
});
