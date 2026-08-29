const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  applyListSurfaceAfterIngest,
  effectiveHiddenReason,
  foldByHuman,
  foldByPolicy,
  foldThreadByPolicy,
  nextHiddenPref,
  normalizeInboxListView,
  unfold,
  writeHiddenPref,
} = require("../dist");

describe("list surface", () => {
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

  it("does not rewrite an already policy-hidden thread", () => {
    assert.deepEqual(foldByPolicy({ hidden: true, reason: "policy" }), undefined);
    assert.deepEqual(foldByPolicy({ hidden: false, reason: null }), {
      hidden: true,
      reason: "policy",
    });
  });

  it("writes hide prefs through the store port only", async () => {
    const prefs = new Map();
    const store = {
      async getConversationPref(_orgId, threadId) {
        return prefs.get(threadId) ?? null;
      },
      async putConversationPref(input) {
        const next = {
          org_id: input.org_id,
          thread_id: input.thread_id,
          title: null,
          pinned: false,
          hidden: input.hidden === true,
          hidden_reason: input.hidden_reason ?? null,
          last_read_at: null,
          last_read_external_id: null,
          updated_at: input.updated_at,
        };
        prefs.set(input.thread_id, next);
        return next;
      },
    };
    await foldThreadByPolicy(store, "org", "crm:order-1", "t1");
    assert.deepEqual(prefs.get("crm:order-1")?.hidden_reason, "policy");
    await writeHiddenPref(
      store,
      "org",
      "crm:order-1",
      foldByHuman(),
      "t2",
    );
    assert.equal(prefs.get("crm:order-1")?.hidden_reason, "human");
    await foldThreadByPolicy(store, "org", "crm:order-1", "t3");
    assert.equal(prefs.get("crm:order-1")?.updated_at, "t2");
  });

  it("applies ingest folds from accepted events, not connector names", async () => {
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
    const prefs = new Map();
    const store = {
      async getEvent(_orgId, id) {
        return events.get(id) ?? null;
      },
      async getDisposition() {
        return { disposition: "outside_current_work" };
      },
      async getConversationPref(_orgId, threadId) {
        return prefs.get(threadId) ?? null;
      },
      async putConversationPref(input) {
        const next = {
          org_id: input.org_id,
          thread_id: input.thread_id,
          title: null,
          pinned: false,
          hidden: input.hidden === true,
          hidden_reason: input.hidden_reason ?? null,
          last_read_at: null,
          last_read_external_id: null,
          updated_at: input.updated_at,
        };
        prefs.set(input.thread_id, next);
        return next;
      },
      async listInbox() {
        return [];
      },
    };
    await applyListSurfaceAfterIngest(store, "org", ["gone"]);
    const pref = prefs.get("crm:order-1");
    assert.equal(pref?.hidden, true);
    assert.equal(pref?.hidden_reason, "policy");
  });
});
